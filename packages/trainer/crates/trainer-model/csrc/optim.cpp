// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// The multi-tensor AdamW step and gradient clip that `torch.optim.AdamW(fused=True)` and
// `clip_grad_norm_(foreach=True)` issue in torch 2.13, for the tensor-list operations `tch` does not expose.
//
// Each call takes its tensors as arrays of `at::Tensor` handles. A list operation launches one kernel per chunk of
// tensors rather than one per tensor, which is what removes the per-tensor launches from a CUDA step.
// On failure a call writes libtorch's message into `err` (truncated to `err_len` bytes) and returns -1 or null.

#include <ATen/ATen.h>
#include <cstring>
#include <exception>
#include <vector>

namespace {
std::vector<at::Tensor> tensors(at::Tensor** handles, size_t n) {
  std::vector<at::Tensor> out;
  out.reserve(n);
  for (size_t i = 0; i < n; i++) out.push_back(*handles[i]);
  return out;
}

void write_error(const std::exception& e, char* err, size_t err_len) {
  if (err == nullptr || err_len == 0) return;
  std::strncpy(err, e.what(), err_len - 1);
  err[err_len - 1] = '\0';
}
}  // namespace

extern "C" {

// `torch.optim.adam._fused_adam` with decoupled weight decay: `torch._foreach_add_(state_steps, 1)`, then
// `torch._fused_adamw_` over the parameters, their gradients, both moments and the step counts. Every tensor sits on
// one device in one dtype, and each step count is a float32 scalar on that device. Returns 0, or -1 on failure.
int trainer_fused_adamw(at::Tensor** params, at::Tensor** grads, at::Tensor** exp_avgs, at::Tensor** exp_avg_sqs,
                        at::Tensor** steps, size_t n, double lr, double beta1, double beta2, double weight_decay,
                        double eps, char* err, size_t err_len) {
  try {
    auto step_list = tensors(steps, n);
    at::_foreach_add_(step_list, 1);
    at::_fused_adamw_(tensors(params, n), tensors(grads, n), tensors(exp_avgs, n), tensors(exp_avg_sqs, n), {},
                      step_list, lr, beta1, beta2, weight_decay, eps, /*amsgrad=*/false, /*maximize=*/false);
    return 0;
  } catch (const std::exception& e) {
    write_error(e, err, err_len);
    return -1;
  }
}

// `clip_grad_norm_(grads, max_norm, foreach=True)`: the per-gradient 2-norms by `torch._foreach_norm`, their 2-norm,
// then `torch._foreach_mul_(grads, clamp(max_norm / (total + 1e-6), max=1))`. Returns the total norm before clipping
// as a new tensor the caller owns, or null on failure.
at::Tensor* trainer_clip_grad_norm_foreach(at::Tensor** grads, size_t n, double max_norm, char* err, size_t err_len) {
  try {
    auto list = tensors(grads, n);
    auto norms = at::_foreach_norm(list, 2);
    auto total = at::linalg_vector_norm(at::stack(norms), 2);
    auto coef = ((total + 1e-6).reciprocal() * max_norm).clamp_max(1.0);
    at::_foreach_mul_(list, coef);
    return new at::Tensor(total);
  } catch (const std::exception& e) {
    write_error(e, err, err_len);
    return nullptr;
  }
}
}
