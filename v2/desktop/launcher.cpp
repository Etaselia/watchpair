// Stable per-user entry point. No Qt/runtime DLL dependency: a failed update
// can invoke the previous version's recovery helper before opening its profile.
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
// Windows declarations must precede shellapi (clang-format sorts includes).
#include <windows.h>

#include <shellapi.h>
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <unistd.h>
#endif
namespace fs = std::filesystem;
namespace {
std::vector<std::string> lines(const fs::path &path) {
  if (!fs::is_regular_file(path) || fs::file_size(path) > 327680)
    return {};
  std::ifstream in(path, std::ios::binary);
  std::vector<std::string> result;
  std::string line;
  while (std::getline(in, line) && result.size() < 10) {
    if (line.size() > 32768)
      return {};
    if (!line.empty() && line.back() == '\r')
      line.pop_back();
    result.push_back(line);
  }
  return result;
}
bool version(const std::string &text) {
  if (text.empty() || text.size() > 96 || text.front() == '.' || text.back() == '.')
    return false;
  for (const char c : text)
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.'))
      return false;
  return true;
}
bool alive(unsigned long pid) {
  if (pid == 0)
    return false;
#ifdef _WIN32
  HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (!process)
    return GetLastError() == ERROR_ACCESS_DENIED;
  const bool running = WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
  CloseHandle(process);
  return running;
#else
#ifdef __linux__
  // An orphaned child may remain a zombie briefly on container/desktop init
  // implementations. kill(pid, 0) alone would mistake it for a live update.
  std::ifstream status("/proc/" + std::to_string(pid) + "/stat");
  std::string state;
  if (std::getline(status, state)) {
    const auto end = state.rfind(')');
    if (end != std::string::npos && end + 2 < state.size() && state[end + 2] == 'Z')
      return false;
  }
#endif
  return kill(static_cast<pid_t>(pid), 0) == 0 || errno == EPERM;
#endif
}
void attempt(const fs::path &root, const std::string &nonce, unsigned long pid) {
  const auto temporary = root / "attempt.next";
  {
    std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
    out << nonce << '\n' << pid << '\n';
    out.flush();
    if (!out)
      throw std::runtime_error("Could not record the update launch");
  }
#ifdef _WIN32
  if (!MoveFileExW(temporary.c_str(), (root / "attempt.txt").c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    throw std::runtime_error("Could not commit the update launch");
#else
  fs::rename(temporary, root / "attempt.txt");
#endif
}
#ifdef _WIN32
std::wstring quote(const std::wstring &arg) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t c : arg) {
    if (c == L'\\') {
      ++slashes;
      continue;
    }
    result.append(slashes * (c == L'"' ? 2 : 1), L'\\');
    if (c == L'"')
      result += L'\\';
    result += c;
    slashes = 0;
  }
  result.append(slashes * 2, L'\\');
  return result + L'"';
}
void spawn(const fs::path &exe, const std::vector<fs::path> &args, const fs::path &root,
           const std::string &nonce) {
  std::wstring command = quote(exe.wstring());
  for (const auto &a : args)
    command += L" " + quote(a.wstring());
  STARTUPINFOW startup{sizeof(startup)};
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED, nullptr,
                      exe.parent_path().c_str(), &startup, &process))
    throw std::runtime_error("The installed application could not start");
  try {
    if (!nonce.empty())
      attempt(root, nonce, process.dwProcessId);
  } catch (...) {
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    throw;
  }
  ResumeThread(process.hThread);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
}
#else
void spawn(const fs::path &exe, const std::vector<fs::path> &args, const fs::path &root,
           const std::string &nonce) {
  int gate[2];
  if (pipe(gate) != 0)
    throw std::runtime_error("Cannot prepare application launch");
  const auto pid = fork();
  if (pid < 0) {
    close(gate[0]);
    close(gate[1]);
    throw std::runtime_error("Cannot start application");
  }
  if (pid == 0) {
    close(gate[1]);
    char ready = 0;
    const auto n = read(gate[0], &ready, 1);
    close(gate[0]);
    if (n != 1 || ready != '1')
      _exit(1);
    setsid();
    // The launcher exits immediately. Its caller may close captured pipes at
    // that point; inheriting them would kill the desktop on its next log write.
    const int null = open("/dev/null", O_RDWR);
    if (null < 0)
      _exit(127);
    for (int descriptor = 0; descriptor < 3; ++descriptor)
      if (dup2(null, descriptor) < 0)
        _exit(127);
    if (null > 2)
      close(null);
    std::vector<std::string> strings{exe.string()};
    for (const auto &a : args)
      strings.push_back(a.string());
    std::vector<char *> values;
    for (auto &s : strings)
      values.push_back(s.data());
    values.push_back(nullptr);
    execv(exe.c_str(), values.data());
    _exit(127);
  }
  close(gate[0]);
  try {
    if (!nonce.empty())
      attempt(root, nonce, static_cast<unsigned long>(pid));
  } catch (...) {
    close(gate[1]);
    kill(pid, SIGTERM);
    throw;
  }
  const char ready = '1';
  if (write(gate[1], &ready, 1) != 1) {
    close(gate[1]);
    throw std::runtime_error("Cannot release application launch");
  }
  close(gate[1]);
}
#endif
int launch(const fs::path &self, const std::vector<fs::path> &original) {
  const auto root = self.parent_path();
  const auto marker = lines(root / ".watchpair-runtime");
  const auto current = lines(root / "current.txt"), profile = lines(root / "profile.txt");
  if (marker.empty() || marker[0] != "watchpair-runtime-v1" || current.empty() || !version(current[0]) ||
      profile.size() != 1 || !fs::u8path(profile[0]).is_absolute())
    throw std::runtime_error("The installation record is missing or damaged");
  auto selected = current[0];
  std::vector<fs::path> args;
  std::string nonce;
  const auto pending = lines(root / "pending.txt");
  if (pending.size() == 3 && pending[1] == selected && version(pending[0]) && version(pending[2])) {
    const auto tried = lines(root / "attempt.txt"), healthy = lines(root / "healthy.txt");
    const bool confirmed = !healthy.empty() && healthy[0] == pending[2];
    unsigned long pid = 0;
    if (tried.size() == 2 && tried[0] == pending[2]) {
      try {
        pid = std::stoul(tried[1]);
      } catch (...) {
        throw std::runtime_error("The update launch record is damaged");
      }
    }
    if (!confirmed && pid != 0 && !alive(pid)) {
      selected = pending[0];
      args = {fs::path("--recover-update"), root};
    } else if (!confirmed)
      nonce = pending[2];
  }
  if (args.empty())
    args = {fs::path("--profile"), fs::u8path(profile[0])};
  args.insert(args.end(), original.begin(), original.end());
#ifdef _WIN32
  const auto exe = root / "versions" / selected / "watchpair.exe";
#else
  const auto exe = root / "versions" / selected / "AppRun";
#endif
  if (!fs::is_regular_file(exe) && pending.size() == 3 && pending[1] == selected && version(pending[0])) {
#ifdef _WIN32
    const auto recovery = root / "versions" / pending[0] / "watchpair.exe";
#else
    const auto recovery = root / "versions" / pending[0] / "AppRun";
#endif
    if (fs::is_regular_file(recovery)) {
      std::vector<fs::path> recoveryArgs{fs::path("--recover-update"), root};
      recoveryArgs.insert(recoveryArgs.end(), original.begin(), original.end());
      spawn(recovery, recoveryArgs, root, {});
      return 0;
    }
  }
  if (!fs::is_regular_file(exe))
    throw std::runtime_error("The selected application version is missing");
  spawn(exe, args, root, nonce);
  return 0;
}
} // namespace
#ifdef _WIN32
int WINAPI wWinMain(HINSTANCE, HINSTANCE, LPWSTR, int) {
  try {
    std::vector<wchar_t> path(32768);
    if (!GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size())))
      return 1;
    int count = 0;
    auto **values = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!values)
      return 1;
    std::vector<fs::path> args;
    for (int i = 1; i < count; ++i)
      args.emplace_back(values[i]);
    LocalFree(values);
    return launch(fs::path(path.data()), args);
  } catch (...) {
    MessageBoxW(nullptr,
                L"WatchPair could not open its installed version. Run the previous portable bundle or "
                L"reinstall. Your media and room profile were kept.",
                L"WatchPair recovery", MB_OK | MB_ICONERROR);
    return 1;
  }
}
#else
int main(int argc, char **argv) {
  try {
    std::vector<fs::path> args;
    for (int i = 1; i < argc; ++i)
      args.emplace_back(argv[i]);
    return launch(fs::canonical("/proc/self/exe"), args);
  } catch (const std::exception &e) {
    std::fprintf(stderr,
                 "WatchPair: %s. Reinstall from a portable bundle; your profile and media were kept.\n",
                 e.what());
    return 1;
  }
}
#endif
