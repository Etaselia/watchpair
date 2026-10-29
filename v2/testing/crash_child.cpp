// Internal delivery test fixture; never included in application packages.
#ifdef _WIN32
#include <windows.h>
int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
  return 23;
}
#else
int main() {
  return 23;
}
#endif
