// The autocast state `torch.autocast(device_type, dtype)` sets, for a device type `tch` does not reach.
//
// `tch::autocast` calls `at::autocast::set_enabled`, which switches CUDA autocast only. A CPU run under autocast,
// and a CUDA run in a named dtype, need the per-device calls below. Entering and leaving follow
// `torch.amp.autocast_mode.autocast.__enter__` and `__exit__` in torch 2.13: save the device's state, set it,
// increment the nesting; on leaving, clear the cast cache when the nesting returns to zero and restore the state.

#include <ATen/autocast_mode.h>
#include <c10/core/GradMode.h>
#include <ATen/ATen.h>
#include <ATen/CPUGeneratorImpl.h>
#include <mutex>
#include <exception>

namespace {
c10::DeviceType device_type(int device) { return device == 1 ? c10::DeviceType::CUDA : c10::DeviceType::CPU; }
c10::ScalarType scalar_type(int dtype) { return dtype == 1 ? c10::ScalarType::Half : c10::ScalarType::BFloat16; }
}  // namespace

extern "C" {

// Enters an autocast region on `device` (0 CPU, 1 CUDA), enabled or not, in `dtype` (0 bfloat16, 1 float16, -1
// the device's current dtype, as `torch.autocast(enabled=False)` keeps it). Writes the previous enabled flag, dtype
// code and cache flag to the out parameters. Returns 0, or -1 when libtorch raised.
int trainer_autocast_enter(int device, int enabled, int dtype, int* prev_enabled, int* prev_dtype, int* prev_cache) {
  try {
    auto type = device_type(device);
    *prev_enabled = at::autocast::is_autocast_enabled(type) ? 1 : 0;
    *prev_dtype = at::autocast::get_autocast_dtype(type) == c10::ScalarType::Half ? 1 : 0;
    *prev_cache = at::autocast::is_autocast_cache_enabled() ? 1 : 0;
    at::autocast::set_autocast_enabled(type, enabled != 0);
    if (dtype >= 0) {
      at::autocast::set_autocast_dtype(type, scalar_type(dtype));
    }
    at::autocast::increment_nesting();
    at::autocast::set_autocast_cache_enabled(true);
    return 0;
  } catch (const std::exception&) {
    return -1;
  }
}

// Leaves the region `trainer_autocast_enter` opened, restoring the state it reported.
int trainer_autocast_exit(int device, int prev_enabled, int prev_dtype, int prev_cache) {
  try {
    auto type = device_type(device);
    if (at::autocast::decrement_nesting() == 0) {
      at::autocast::clear_cache();
    }
    at::autocast::set_autocast_enabled(type, prev_enabled != 0);
    at::autocast::set_autocast_dtype(type, scalar_type(prev_dtype));
    at::autocast::set_autocast_cache_enabled(prev_cache != 0);
    return 0;
  } catch (const std::exception&) {
    return -1;
  }
}

// Whether autocast is on for `device`: 1, 0, or -1 when libtorch raised.
int trainer_autocast_is_enabled(int device) {
  try {
    return at::autocast::is_autocast_enabled(device_type(device)) ? 1 : 0;
  } catch (const std::exception&) {
    return -1;
  }
}

// `torch.is_grad_enabled()`, which `MultiheadAttention.forward` reads to choose its fast path.
int trainer_grad_enabled() { return at::GradMode::is_enabled() ? 1 : 0; }

// `param.grad = None`, which `optimizer.zero_grad(set_to_none=True)` does. A parameter left without a gradient
// is skipped by AdamW, so zero-filling it instead would decay and move it.
void trainer_clear_grad(at::Tensor* t) { t->mutable_grad().reset(); }

// `torch.Generator().manual_seed(seed)`: a CPU generator of its own, which the MLM mask draws from.
at::Generator* trainer_generator_new(uint64_t seed) {
  try {
    auto* g = new at::Generator(at::detail::createCPUGenerator());
    std::lock_guard<std::mutex> lock(g->mutex());
    g->set_current_seed(seed);
    return g;
  } catch (const std::exception&) {
    return nullptr;
  }
}

void trainer_generator_free(at::Generator* g) { delete g; }

// `torch.bernoulli(probs, generator=g)`.
at::Tensor* trainer_bernoulli(const at::Tensor* probs, at::Generator* g) {
  try {
    return new at::Tensor(at::bernoulli(*probs, *g));
  } catch (const std::exception&) {
    return nullptr;
  }
}

// `torch.randint(low, high, shape, generator=g)`, int64.
at::Tensor* trainer_randint(int64_t low, int64_t high, const int64_t* shape, int ndim, at::Generator* g) {
  try {
    return new at::Tensor(at::randint(low, high, at::IntArrayRef(shape, ndim), *g, at::TensorOptions().dtype(at::kLong)));
  } catch (const std::exception&) {
    return nullptr;
  }
}

// `torch.linalg.vector_norm(t, 2)`, which `clip_grad_norm_` sums the gradients with and `tch` does not expose.
// Returns a new tensor the caller owns, or null when libtorch raised.
at::Tensor* trainer_vector_norm(const at::Tensor* t) {
  try {
    return new at::Tensor(at::linalg_vector_norm(*t, 2));
  } catch (const std::exception&) {
    return nullptr;
  }
}
}
