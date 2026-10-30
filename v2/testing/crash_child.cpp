// Internal delivery test fixture; never included in application packages.
#include <chrono>
#include <string>
#include <thread>
namespace {
int finish(const std::string &argument) {
  if (argument.starts_with("--hold-ms=")) {
    try {
      const auto milliseconds = std::stoi(argument.substr(10));
      if (milliseconds >= 0 && milliseconds <= 5000)
        std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
    } catch (...) {
    }
  }
  return 23;
}
} // namespace
#ifdef _WIN32
#include <windows.h>
int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR argument, int) {
  return finish(argument);
}
#else
int main(int argc, char **argv) {
  return finish(argc > 1 ? argv[1] : "");
}
#endif
