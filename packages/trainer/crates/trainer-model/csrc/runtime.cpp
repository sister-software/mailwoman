// What the linked libtorch reports about itself, for the runtime block of a parity record.
//
// The Python reference records `torch.__version__`, `torch.get_num_threads()` and
// `torch.backends.cpu.get_cpu_capability()`. The last is `at::get_cpu_capability()`, and the version is in the build
// settings `at::show_config()` prints. Both are read from the shared library the process loaded, and `dladdr` names
// that library's file.

#include <ATen/Version.h>
#include <dlfcn.h>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <string>

namespace {
char* owned_copy(const std::string& value) { return strdup(value.c_str()); }
}  // namespace

extern "C" {

// `at::show_config()`, as a heap string the caller frees with `trainer_free_string`. Null when libtorch raised.
char* trainer_show_config() {
  try {
    return owned_copy(at::show_config());
  } catch (const std::exception&) {
    return nullptr;
  }
}

// `at::get_cpu_capability()`: the kernel set ATen dispatches to on this CPU, such as `AVX512`. Null when libtorch raised.
char* trainer_cpu_capability() {
  try {
    return owned_copy(at::get_cpu_capability());
  } catch (const std::exception&) {
    return nullptr;
  }
}

// The path of the shared object that defines `at::show_config`, which is the libtorch the process loaded. Null when
// the dynamic linker cannot name it.
char* trainer_libtorch_library() {
  Dl_info info;
  std::string (*symbol)() = &at::show_config;
  if (dladdr(reinterpret_cast<void*>(symbol), &info) == 0 || info.dli_fname == nullptr) {
    return nullptr;
  }
  return strdup(info.dli_fname);
}

void trainer_free_string(char* value) { free(value); }

}  // extern "C"
