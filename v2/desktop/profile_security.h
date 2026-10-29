#pragma once
#include "local_store.h"
#include <QDir>
#include <QFile>
#ifdef Q_OS_WIN
#include <aclapi.h>
#include <windows.h>
#endif
namespace wp {
inline void secureProfile(const QString &path) {
  if (!QDir().mkpath(path))
    throw AppError(QStringLiteral("PROFILE_ACCESS"),
                   QStringLiteral("Cannot create the private application profile."));
#ifdef Q_OS_WIN
  HANDLE token = nullptr;
  DWORD length = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
    throw AppError(QStringLiteral("PROFILE_ACCESS"),
                   QStringLiteral("Cannot protect the private application profile."));
  GetTokenInformation(token, TokenUser, nullptr, 0, &length);
  QByteArray user(int(length), '\0');
  const bool obtained = GetTokenInformation(token, TokenUser, user.data(), length, &length);
  CloseHandle(token);
  if (!obtained)
    throw AppError(QStringLiteral("PROFILE_ACCESS"), QStringLiteral("Cannot identify the profile owner."));
  EXPLICIT_ACCESSW access{};
  access.grfAccessPermissions = FILE_ALL_ACCESS;
  access.grfAccessMode = SET_ACCESS;
  access.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access.Trustee.TrusteeType = TRUSTEE_IS_USER;
  access.Trustee.ptstrName = reinterpret_cast<LPWSTR>(reinterpret_cast<TOKEN_USER *>(user.data())->User.Sid);
  PACL acl = nullptr;
  const auto made = SetEntriesInAclW(1, &access, nullptr, &acl);
  const auto result =
      made == ERROR_SUCCESS
          ? SetNamedSecurityInfoW(
                const_cast<LPWSTR>(reinterpret_cast<LPCWSTR>(QDir::toNativeSeparators(path).utf16())),
                SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr,
                nullptr, acl, nullptr)
          : made;
  if (acl)
    LocalFree(acl);
  if (result != ERROR_SUCCESS)
    throw AppError(QStringLiteral("PROFILE_ACCESS"),
                   QStringLiteral("Cannot restrict profile access to your Windows account. Choose a private "
                                  "local profile folder."));
#else
  if (!QFile::setPermissions(path, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner))
    throw AppError(QStringLiteral("PROFILE_ACCESS"),
                   QStringLiteral("Cannot protect the private application profile."));
#endif
}
} // namespace wp
