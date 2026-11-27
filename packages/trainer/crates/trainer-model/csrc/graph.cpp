// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// `torch.cuda.CUDAGraph` for the training step: capture on a side stream into a shared memory pool, replay, free.
//
// The build script compiles this file only against a CUDA libtorch with the CUDA headers present, because
// `at::cuda::CUDAGraph` lives in `libtorch_cuda.so`. `cuda.h` comes first: it defines `CUDA_VERSION`, and
// `CUDAGraph`'s members depend on it, so the struct this file allocates has the layout libtorch_cuda was built with.
//
// Capture follows `torch.cuda.graph.__enter__` and `__exit__`: synchronize the device, switch to a stream from the
// pool (a graph is never captured on the default stream), capture, then restore the caller's stream and synchronize
// the device again, so the caller's stream sees everything the capture allocated. A replay runs on the caller's
// current stream.
// On failure a call writes libtorch's message into `err` (truncated to `err_len` bytes) and returns -1 or null.

#include <cuda.h>

#include <ATen/ATen.h>
#include <ATen/cuda/CUDAGeneratorImpl.h>
#include <ATen/cuda/CUDAGraph.h>
#include <c10/cuda/CUDAFunctions.h>
#include <c10/cuda/CUDAGuard.h>
#include <c10/cuda/CUDAStream.h>
#include <cstdint>
#include <cstring>
#include <exception>
#include <optional>

namespace {
void write_error(const std::exception& e, char* err, size_t err_len) {
  if (err == nullptr || err_len == 0) return;
  std::strncpy(err, e.what(), err_len - 1);
  err[err_len - 1] = '\0';
}

// One graph and the stream state an open capture holds.
struct Graph {
  at::cuda::CUDAGraph graph;
  std::optional<c10::cuda::CUDAStream> capture_stream;
  std::optional<c10::cuda::CUDAStreamGuard> guard;
  c10::DeviceIndex device = 0;
};
}  // namespace

extern "C" {

// The number of CUDA devices this process sees, or -1 when libtorch raised.
int trainer_cuda_graph_device_count() {
  try {
    return static_cast<int>(c10::cuda::device_count());
  } catch (const std::exception&) {
    return -1;
  }
}

// `torch.cuda.graph_pool_handle()`: a memory pool id that several captures share. Returns 0, or -1 on failure.
int trainer_cuda_graph_pool_handle(uint64_t* first, uint64_t* second, char* err, size_t err_len) {
  try {
    auto pool = at::cuda::graph_pool_handle();
    *first = pool.first;
    *second = pool.second;
    return 0;
  } catch (const std::exception& e) {
    write_error(e, err, err_len);
    return -1;
  }
}

// A new, empty graph, or null on failure.
void* trainer_cuda_graph_new(char* err, size_t err_len) {
  try {
    return new Graph();
  } catch (const std::exception& e) {
    write_error(e, err, err_len);
    return nullptr;
  }
}

// Opens a capture on CUDA device `device` into the pool `(pool_first, pool_second)`. The default CUDA generator's
// state is registered with the graph first, so every replay draws fresh dropout masks: the graph advances the
// generator's offset by the draws it recorded. Returns 0, or -1 on failure.
int trainer_cuda_graph_capture_begin(void* handle, int device, uint64_t pool_first, uint64_t pool_second, char* err,
                                     size_t err_len) {
  try {
    auto* g = static_cast<Graph*>(handle);
    g->device = static_cast<c10::DeviceIndex>(device);
    c10::cuda::CUDAGuard device_guard(g->device);
    c10::cuda::device_synchronize();
    g->capture_stream = c10::cuda::getStreamFromPool(/*isHighPriority=*/false, g->device);
    g->guard.emplace(*g->capture_stream);
    g->graph.register_generator_state(at::cuda::detail::getDefaultCUDAGenerator(g->device));
    g->graph.capture_begin({pool_first, pool_second});
    return 0;
  } catch (const std::exception& e) {
    auto* g = static_cast<Graph*>(handle);
    g->guard.reset();
    write_error(e, err, err_len);
    return -1;
  }
}

// Closes the capture `trainer_cuda_graph_capture_begin` opened and instantiates the graph, then restores the caller's
// stream and synchronizes the device. Returns 0, or -1 on failure.
int trainer_cuda_graph_capture_end(void* handle, char* err, size_t err_len) {
  auto* g = static_cast<Graph*>(handle);
  try {
    g->graph.capture_end();
    g->guard.reset();
    c10::cuda::CUDAGuard device_guard(g->device);
    c10::cuda::device_synchronize();
    return 0;
  } catch (const std::exception& e) {
    g->guard.reset();
    write_error(e, err, err_len);
    return -1;
  }
}

// Launches the captured work on the current stream. Returns 0, or -1 on failure.
int trainer_cuda_graph_replay(void* handle, char* err, size_t err_len) {
  try {
    auto* g = static_cast<Graph*>(handle);
    c10::cuda::CUDAGuard device_guard(g->device);
    g->graph.replay();
    return 0;
  } catch (const std::exception& e) {
    write_error(e, err, err_len);
    return -1;
  }
}

// Frees the graph and its executable. Its pool's memory returns to the caching allocator once no graph uses it.
void trainer_cuda_graph_free(void* handle) { delete static_cast<Graph*>(handle); }

}  // extern "C"
