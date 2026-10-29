#include "release_manager.h"
#include "profile_security.h"
#include "transfer_engine.h"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDirIterator>
#include <QFileInfo>
#include <QJsonDocument>
#include <QLockFile>
#include <QRegularExpression>
#include <QSaveFile>
#include <QSqlError>
#include <QSqlQuery>
#include <QStandardPaths>
#include <QStorageInfo>
#include <QTemporaryDir>
#include <QThread>
#include <QUuid>
#include <QtConcurrent>
#include <archive.h>
#include <archive_entry.h>
#include <openssl/evp.h>
#ifdef Q_OS_WIN
#include <windows.h>
#else
#include <cerrno>
#include <csignal>
#endif
#ifndef WATCHPAIR_UPDATE_PUBLIC_KEY
#define WATCHPAIR_UPDATE_PUBLIC_KEY ""
#endif
namespace wp::delivery {
namespace {
constexpr qint64 maximum = 2LL * 1024 * 1024 * 1024;
void fail(const QString &message) {
  throw AppError(QStringLiteral("APPLICATION_DELIVERY"), message);
}
QByteArray read(const QString &path, qint64 limit = 16 * 1024 * 1024) {
  QFile file(path);
  if (!file.open(QIODevice::ReadOnly) || file.size() > limit)
    fail(QStringLiteral("An installation record is missing, unreadable or too large."));
  return file.readAll();
}
void save(const QString &path, const QByteArray &data) {
  QSaveFile file(path);
  if (!file.open(QIODevice::WriteOnly) || file.write(data) != data.size() || !file.commit())
    fail(QStringLiteral("Cannot commit the installation. Check free space and write access."));
}
QJsonObject json(const QString &path) {
  QJsonParseError error;
  const auto value = QJsonDocument::fromJson(read(path), &error);
  if (error.error != QJsonParseError::NoError || !value.isObject())
    fail(QStringLiteral("An installation record is damaged."));
  return value.object();
}
QByteArray digest(const QString &path) {
  QFile file(path);
  QCryptographicHash hash(QCryptographicHash::Sha256);
  if (!file.open(QIODevice::ReadOnly) || !hash.addData(&file))
    fail(QStringLiteral("Cannot verify an application or backup file."));
  return hash.result().toHex();
}
bool safe(const QString &path) {
  if (path.isEmpty() || path.size() > 800 || path.startsWith(QLatin1Char('/')) ||
      path.contains(QLatin1Char('\\')) || path.contains(QLatin1Char(':')) ||
      path.contains(QRegularExpression(QStringLiteral("[\\x00-\\x1f\\x7f]"))))
    return false;
  for (const auto &part : path.split(QLatin1Char('/')))
    if (part.isEmpty() || part == QStringLiteral(".") || part == QStringLiteral("..") ||
        part.endsWith(QLatin1Char('.')) || part.endsWith(QLatin1Char(' ')) ||
        QRegularExpression(QStringLiteral("^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])([.]|$)"),
                           QRegularExpression::CaseInsensitiveOption)
            .match(part)
            .hasMatch())
      return false;
  return true;
}
bool key(const QString &text) {
  return QRegularExpression(QStringLiteral("^[A-Za-z0-9][A-Za-z0-9.-]{0,95}$")).match(text).hasMatch();
}
QString normalized(const QString &directory) {
  const QFileInfo info(directory);
  if (!info.isDir() || info.isSymLink() || info.canonicalFilePath().isEmpty())
    fail(QStringLiteral("Choose an accessible real directory for the installation."));
  return info.canonicalFilePath();
}
QString profile(const QString &root) {
  if (read(root + QStringLiteral("/.watchpair-runtime"), 256) != "watchpair-runtime-v1\n")
    fail(QStringLiteral("This directory is not owned by the WatchPair installer."));
  const auto value = QString::fromUtf8(read(root + QStringLiteral("/profile.txt"), 32768)).trimmed();
  if (!QDir::isAbsolutePath(value) || value.contains(QLatin1Char('\n')) || value.isEmpty())
    fail(QStringLiteral("The installed profile association is damaged."));
  return normalized(value);
}
QString current(const QString &root) {
  const auto value = QString::fromLatin1(read(root + QStringLiteral("/current.txt"), 128)).trimmed();
  if (!key(value))
    fail(QStringLiteral("The installed version pointer is damaged."));
  return value;
}
void copy(const QString &from, const QString &to, const QByteArray &expected = {}) {
  QFile input(from);
  QSaveFile output(to);
  QCryptographicHash hash(QCryptographicHash::Sha256);
  if (QFileInfo(from).isSymLink() || !input.open(QIODevice::ReadOnly) || !output.open(QIODevice::WriteOnly))
    fail(QStringLiteral("Cannot copy an application file. Check access and free disk space."));
  while (!input.atEnd()) {
    const auto data = input.read(1024 * 1024);
    if (data.isEmpty() && input.error() != QFile::NoError)
      fail(QStringLiteral("Reading an application file failed."));
    hash.addData(data);
    if (output.write(data) != data.size())
      fail(QStringLiteral("There is not enough space to install this version."));
  }
  if (!expected.isEmpty() && hash.result().toHex() != expected)
    fail(QStringLiteral("An application file changed or failed its checksum. Download a fresh bundle."));
  if (!output.commit())
    fail(QStringLiteral("Cannot commit an application file."));
  QFile::setPermissions(to, QFileInfo(from).permissions() &
                                (QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner | QFile::ReadGroup |
                                 QFile::ExeGroup | QFile::ReadOther | QFile::ExeOther));
}
void checkDatabase(const QString &path) {
  const auto connection = QUuid::createUuid().toString();
  bool valid = false;
  {
    auto db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection);
    db.setDatabaseName(path);
    db.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
    if (db.open()) {
      QSqlQuery query(db);
      valid = query.exec(QStringLiteral("PRAGMA quick_check")) && query.next() &&
              query.value(0).toString() == QStringLiteral("ok");
    }
    db.close();
  }
  QSqlDatabase::removeDatabase(connection);
  if (!valid)
    fail(QStringLiteral("The profile backup failed its SQLite integrity check."));
}
} // namespace
QString platform() {
#ifdef Q_OS_WIN
  return QStringLiteral("windows-x64");
#else
  return QStringLiteral("linux-x64");
#endif
}
QString bundleRoot() {
  const auto app = QCoreApplication::applicationDirPath();
  return QFileInfo::exists(app + QStringLiteral("/runtime-manifest.json"))
             ? app
             : QFileInfo(app).dir().absolutePath();
}
QString runningRoot() {
  const QDir version(bundleRoot());
  const auto root = QDir(version.absoluteFilePath(QStringLiteral("../.."))).absolutePath();
  if (QFileInfo(version.absolutePath()).dir().dirName() != QStringLiteral("versions") ||
      !QFileInfo::exists(root + QStringLiteral("/.watchpair-runtime")))
    return {};
  return root;
}
QString launcher(const QString &root) {
#ifdef Q_OS_WIN
  return root + QStringLiteral("/WatchPair.exe");
#else
  return root + QStringLiteral("/WatchPair");
#endif
}
QString defaultRoot() {
  return QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation) + QStringLiteral("/runtime");
}
int compareVersions(const QString &left, const QString &right) {
  auto parts = [](const QString &text) {
    const auto match =
        QRegularExpression(QStringLiteral("^(0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})(?"
                                          ":-(alpha|beta|rc)[.](0|[1-9][0-9]{0,5}))?$"))
            .match(text);
    if (!match.hasMatch())
      fail(QStringLiteral("The release version is not a supported semantic version."));
    const int stage =
        match.captured(4).isEmpty()
            ? 3
            : QStringList{QStringLiteral("alpha"), QStringLiteral("beta"), QStringLiteral("rc")}.indexOf(
                  match.captured(4));
    return QList<int>{match.captured(1).toInt(), match.captured(2).toInt(), match.captured(3).toInt(), stage,
                      match.captured(5).toInt()};
  };
  const auto a = parts(left), b = parts(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
Release verifyFeed(const QByteArray &data, const QByteArray &publicKey, const QString &currentVersion,
                   bool requireNewer) {
  if (data.size() > 128 * 1024 || publicKey.size() != 32)
    fail(QStringLiteral("This build has no valid trusted update key, or the feed is too large."));
  const auto envelope = QJsonDocument::fromJson(data).object();
  const auto payload = QByteArray::fromBase64(envelope.value(QStringLiteral("payload")).toString().toLatin1(),
                                              QByteArray::AbortOnBase64DecodingErrors);
  const auto signature =
      QByteArray::fromBase64(envelope.value(QStringLiteral("signature")).toString().toLatin1(),
                             QByteArray::AbortOnBase64DecodingErrors);
  std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key(
      EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, nullptr,
                                  reinterpret_cast<const unsigned char *>(publicKey.data()),
                                  publicKey.size()),
      EVP_PKEY_free);
  std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  if (!key || !context || signature.size() != 64 ||
      EVP_DigestVerifyInit(context.get(), nullptr, nullptr, nullptr, key.get()) != 1 ||
      EVP_DigestVerify(context.get(), reinterpret_cast<const unsigned char *>(signature.data()),
                       signature.size(), reinterpret_cast<const unsigned char *>(payload.data()),
                       payload.size()) != 1)
    fail(QStringLiteral("The update signature is invalid. This release was not accepted."));
  const auto document = QJsonDocument::fromJson(payload).object();
  if (document.value(QStringLiteral("format")).toInt() != 1 ||
      document.value(QStringLiteral("protocol")).toInt() != 2)
    fail(QStringLiteral("This release requires an incompatible update or room protocol."));
  Release result;
  result.version = document.value(QStringLiteral("version")).toString();
  const auto comparison = compareVersions(result.version, currentVersion);
  if (requireNewer && comparison <= 0)
    fail(QStringLiteral(
        "You already have this version or a newer version. Downgrades use Restore previous version."));
  result.protocol = 2;
  result.platform = platform();
  const auto artifact =
      document.value(QStringLiteral("artifacts")).toObject().value(result.platform).toObject();
  result.url = QUrl(artifact.value(QStringLiteral("url")).toString());
  result.sha256 = artifact.value(QStringLiteral("sha256")).toString();
  result.size = artifact.value(QStringLiteral("size")).toInteger();
  result.notes = document.value(QStringLiteral("notes")).toString().left(4000);
  const bool loopback =
      result.url.host() == QStringLiteral("127.0.0.1") || result.url.host() == QStringLiteral("::1");
  if (!result.url.isValid() || result.url.host().isEmpty() || !result.url.userInfo().isEmpty() ||
      (result.url.scheme() != QStringLiteral("https") &&
       !(loopback && result.url.scheme() == QStringLiteral("http"))) ||
      !QRegularExpression(QStringLiteral("^[a-f0-9]{64}$")).match(result.sha256).hasMatch() ||
      result.size <= 0 || result.size > maximum)
    fail(QStringLiteral("This release has no valid package for this platform."));
  return result;
}
QJsonObject verifyBundle(const QString &directory, const QString &expectedVersion) {
  const auto root = normalized(directory);
  const auto manifest = json(root + QStringLiteral("/runtime-manifest.json"));
  const auto version = manifest.value(QStringLiteral("version")).toString();
  compareVersions(version, version);
  if (manifest.value(QStringLiteral("format")).toInt() != 1 ||
      manifest.value(QStringLiteral("platform")).toString() != platform() ||
      manifest.value(QStringLiteral("protocol")).toInt() != 2 ||
      (!expectedVersion.isEmpty() && expectedVersion != version))
    fail(QStringLiteral("The package platform, version or protocol does not match this release."));
  const auto files = manifest.value(QStringLiteral("files")).toArray();
  if (files.isEmpty() || files.size() > 20000)
    fail(QStringLiteral("The package file list is invalid."));
  QSet<QString> names, folded;
  qint64 total = 0;
  for (auto value : files) {
    const auto row = value.toObject();
    const auto path = row.value(QStringLiteral("path")).toString();
    const auto size = row.value(QStringLiteral("size")).toInteger(-1);
    const auto sha = row.value(QStringLiteral("sha256")).toString().toLatin1();
    const QFileInfo info(QDir(root).absoluteFilePath(path));
    total += std::max<qint64>(0, size);
    if (!safe(path) || folded.contains(path.toCaseFolded()) || size < 0 || total > maximum ||
        !info.isFile() || info.isSymLink() || !info.canonicalFilePath().startsWith(root + QLatin1Char('/')) ||
        info.size() != size || sha.size() != 64 || digest(info.absoluteFilePath()) != sha)
      fail(QStringLiteral("The package contains a damaged, unsafe or conflicting file."));
    names.insert(path);
    folded.insert(path.toCaseFolded());
  }
  if (!names.contains(platform() == QStringLiteral("windows-x64") ? QStringLiteral("watchpair.exe")
                                                                  : QStringLiteral("AppRun")) ||
      !names.contains(platform() == QStringLiteral("windows-x64") ? QStringLiteral("watchpair-launcher.exe")
                                                                  : QStringLiteral("watchpair-launcher")))
    fail(QStringLiteral("The package is missing its application or recovery launcher."));
  QDirIterator entries(root, QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System,
                       QDirIterator::Subdirectories);
  while (entries.hasNext()) {
    const auto path = entries.next(), relative = QDir(root).relativeFilePath(path);
    if (entries.fileInfo().isSymLink() ||
        (entries.fileInfo().isFile() && relative != QStringLiteral("runtime-manifest.json") &&
         !names.contains(relative)))
      fail(QStringLiteral("The package contains a file absent from its manifest."));
  }
  return manifest;
}
void extractArchive(const QString &source, const QString &destination) {
  if (QFileInfo::exists(destination) || !QDir().mkpath(destination))
    fail(QStringLiteral("Archive extraction requires a fresh staging directory."));
  std::unique_ptr<archive, decltype(&archive_read_free)> input(archive_read_new(), archive_read_free);
  archive_read_support_filter_all(input.get());
  archive_read_support_format_zip(input.get());
  archive_read_support_format_tar(input.get());
#ifdef Q_OS_WIN
  const auto opened = archive_read_open_filename_w(
      input.get(), reinterpret_cast<const wchar_t *>(source.utf16()), 1024 * 1024);
#else
  const auto path = QFile::encodeName(source);
  const auto opened = archive_read_open_filename(input.get(), path.constData(), 1024 * 1024);
#endif
  if (opened != ARCHIVE_OK)
    fail(QStringLiteral("The downloaded package is not a readable ZIP or tar archive."));
  QSet<QString> names;
  qint64 total = 0;
  int count = 0, result;
  archive_entry *entry = nullptr;
  while ((result = archive_read_next_header(input.get(), &entry)) == ARCHIVE_OK) {
    auto name = QString::fromUtf8(archive_entry_pathname_utf8(entry));
    if (archive_entry_filetype(entry) == AE_IFDIR && name.endsWith(QLatin1Char('/')))
      name.chop(1);
    const auto size = archive_entry_size(entry);
    if (!safe(name) || ++count > 25000 || names.contains(name.toCaseFolded()) ||
        archive_entry_symlink(entry) || archive_entry_hardlink(entry) ||
        (archive_entry_filetype(entry) != AE_IFREG && archive_entry_filetype(entry) != AE_IFDIR) ||
        size < 0 || size > maximum || (total += size) > maximum)
      fail(QStringLiteral(
          "The package archive contains unsafe paths, links, duplicate files or excessive data."));
    names.insert(name.toCaseFolded());
    const auto target = QDir(destination).absoluteFilePath(name);
    if (archive_entry_filetype(entry) == AE_IFDIR) {
      if (!QDir().mkpath(target))
        fail(QStringLiteral("Cannot create a package directory."));
      continue;
    }
    if (!QDir().mkpath(QFileInfo(target).path()))
      fail(QStringLiteral("Cannot create package directories."));
    QSaveFile output(target);
    if (!output.open(QIODevice::WriteOnly))
      fail(QStringLiteral("Cannot write the staged package."));
    qint64 written = 0;
    QByteArray buffer(1024 * 1024, Qt::Uninitialized);
    for (;;) {
      const auto n = archive_read_data(input.get(), buffer.data(), buffer.size());
      if (n == 0)
        break;
      if (n < 0 || (written += n) > size || output.write(buffer.constData(), n) != n)
        fail(QStringLiteral("The archive is damaged or the staging disk is full."));
    }
    if (written != size || !output.commit())
      fail(QStringLiteral("The package contains an incomplete file."));
    auto permissions = QFile::ReadOwner | QFile::WriteOwner | QFile::ReadGroup | QFile::ReadOther;
    if (archive_entry_perm(entry) & 0111)
      permissions |= QFile::ExeOwner | QFile::ExeGroup | QFile::ExeOther;
    QFile::setPermissions(target, permissions);
  }
  if (result != ARCHIVE_EOF)
    fail(QStringLiteral("The archive ended unexpectedly."));
}
QJsonObject installBundle(const QString &bundle, const QString &directory, const QString &profilePath) {
  const auto manifest = verifyBundle(bundle);
  const auto profileName = normalized(profilePath);
  if (profileName.contains(QLatin1Char('\n')) || profileName.contains(QLatin1Char('\r')))
    fail(QStringLiteral("The profile directory contains an unsupported line break."));
  const bool exists = QFileInfo::exists(directory);
  if (exists && !QFileInfo::exists(directory + QStringLiteral("/.watchpair-runtime")))
    fail(QStringLiteral("The chosen folder belongs to something else. Choose a new installation folder."));
  secureProfile(directory);
  const auto root = normalized(directory);
  QLockFile installationLock(root + QStringLiteral("/install.lock"));
  if (!installationLock.tryLock())
    fail(QStringLiteral("Another installation task is using this application folder."));
  if (exists && profile(root) != profileName)
    fail(QStringLiteral("This installation belongs to a different profile."));
  if (!exists) {
    save(root + QStringLiteral("/.watchpair-runtime"), "watchpair-runtime-v1\n");
    save(root + QStringLiteral("/profile.txt"), profileName.toUtf8() + '\n');
  }
  if (!QDir().mkpath(root + QStringLiteral("/versions")) || !QDir().mkpath(root + QStringLiteral("/backups")))
    fail(QStringLiteral("Cannot create the version and backup directories."));
  const auto version = manifest.value(QStringLiteral("version")).toString();
  auto name = version + QLatin1Char('-') +
              QString::fromLatin1(digest(bundle + QStringLiteral("/runtime-manifest.json")).left(12));
  auto destination = root + QStringLiteral("/versions/") + name;
  if (QFileInfo::exists(destination)) {
    try {
      verifyBundle(destination, version);
    } catch (const AppError &) {
      // Repair by allocating another owned version. Do not overwrite a
      // running, modified or damaged runtime directory.
      name += QLatin1Char('-') + QUuid::createUuid().toString(QUuid::WithoutBraces).left(8);
      destination = root + QStringLiteral("/versions/") + name;
    }
  }
  if (!QFileInfo::exists(destination)) {
    QTemporaryDir stage(root + QStringLiteral("/.stage-XXXXXX"));
    if (!stage.isValid())
      fail(QStringLiteral("Cannot allocate private package staging."));
    qint64 needed = 0;
    for (auto row : manifest.value(QStringLiteral("files")).toArray())
      needed += row.toObject().value(QStringLiteral("size")).toInteger();
    if (QStorageInfo(root).bytesAvailable() < needed + 32 * 1024 * 1024)
      fail(QStringLiteral("There is not enough free space for the new version and recovery data."));
    for (auto value : manifest.value(QStringLiteral("files")).toArray()) {
      const auto row = value.toObject();
      const auto path = row.value(QStringLiteral("path")).toString();
      const auto target = stage.filePath(path);
      if (!QDir().mkpath(QFileInfo(target).path()))
        fail(QStringLiteral("Cannot create a staged directory."));
      copy(QDir(bundle).filePath(path), target, row.value(QStringLiteral("sha256")).toString().toLatin1());
    }
    copy(bundle + QStringLiteral("/runtime-manifest.json"),
         stage.filePath(QStringLiteral("runtime-manifest.json")));
    verifyBundle(stage.path(), version);
    if (!QDir().rename(stage.path(), destination))
      fail(QStringLiteral("Cannot commit the staged version."));
  } else
    verifyBundle(destination, version);
  const auto launcherName = platform() == QStringLiteral("windows-x64")
                                ? QStringLiteral("watchpair-launcher.exe")
                                : QStringLiteral("watchpair-launcher");
  if (!QFileInfo::exists(root + QStringLiteral("/current.txt"))) {
    copy(destination + QLatin1Char('/') + launcherName, launcher(root));
    save(root + QStringLiteral("/current.txt"), name.toLatin1() + '\n');
  } else if (current(root) != name) {
    const auto nonce = QUuid::createUuid().toString(QUuid::WithoutBraces);
    save(root + QStringLiteral("/staged.json"),
         QJsonDocument(QJsonObject{{QStringLiteral("format"), 1},
                                   {QStringLiteral("from"), current(root)},
                                   {QStringLiteral("to"), name},
                                   {QStringLiteral("nonce"), nonce},
                                   {QStringLiteral("backup"),
                                    QStringLiteral("backups/") + nonce + QStringLiteral(".sqlite")}})
             .toJson());
  }
  return {
      {QStringLiteral("root"), root}, {QStringLiteral("version"), version}, {QStringLiteral("key"), name}};
}
void activate(const QString &directory) {
  const auto root = normalized(directory), profileName = profile(root);
  QLockFile installationLock(root + QStringLiteral("/install.lock"));
  if (!installationLock.tryLock())
    fail(QStringLiteral("Another installation task is using this application folder."));
  QLockFile lock(profileName + QStringLiteral("/instance.lock"));
  if (!lock.tryLock())
    fail(QStringLiteral("Another WatchPair process still uses this profile. Close it and retry."));
  auto staged = json(root + QStringLiteral("/staged.json"));
  const auto from = staged.value(QStringLiteral("from")).toString(),
             to = staged.value(QStringLiteral("to")).toString(),
             nonce = staged.value(QStringLiteral("nonce")).toString();
  if (!key(from) || !key(to) || !key(nonce) || current(root) != from ||
      staged.value(QStringLiteral("backup")).toString() !=
          QStringLiteral("backups/") + nonce + QStringLiteral(".sqlite"))
    fail(QStringLiteral("The staged activation no longer matches the installed version."));
  verifyBundle(root + QStringLiteral("/versions/") + to);
  auto backup = root + QLatin1Char('/') + staged.value(QStringLiteral("backup")).toString();
  if (QFileInfo::exists(backup)) {
    const auto fresh = QUuid::createUuid().toString(QUuid::WithoutBraces);
    staged.insert(QStringLiteral("nonce"), fresh);
    staged.insert(QStringLiteral("backup"), QStringLiteral("backups/") + fresh + QStringLiteral(".sqlite"));
    save(root + QStringLiteral("/staged.json"), QJsonDocument(staged).toJson());
    backup = root + QLatin1Char('/') + staged.value(QStringLiteral("backup")).toString();
  }
  {
    LocalStore store(profileName);
    store.backup(backup);
  }
  checkDatabase(backup);
  auto activation = staged;
  activation.insert(QStringLiteral("backupSha256"), QString::fromLatin1(digest(backup)));
  save(root + QStringLiteral("/last-activation.json"), QJsonDocument(activation).toJson());
  save(root + QStringLiteral("/pending.txt"),
       from.toLatin1() + '\n' + to.toLatin1() + '\n' +
           staged.value(QStringLiteral("nonce")).toString().toLatin1() + '\n');
  save(root + QStringLiteral("/previous.txt"), from.toLatin1() + '\n');
  save(root + QStringLiteral("/current.txt"), to.toLatin1() + '\n');
  QFile::remove(root + QStringLiteral("/staged.json"));
}
void rollback(const QString &directory) {
  const auto root = normalized(directory), profileName = profile(root);
  QLockFile installationLock(root + QStringLiteral("/install.lock"));
  if (!installationLock.tryLock())
    fail(QStringLiteral("Another installation task is using this application folder."));
  QLockFile lock(profileName + QStringLiteral("/instance.lock"));
  if (!lock.tryLock())
    fail(QStringLiteral("Another WatchPair process still uses this profile. Close it before recovery."));
  const auto activation = json(root + QStringLiteral("/last-activation.json"));
  const auto from = activation.value(QStringLiteral("from")).toString(),
             to = activation.value(QStringLiteral("to")).toString(),
             nonce = activation.value(QStringLiteral("nonce")).toString();
  const auto backupName = QStringLiteral("backups/") + nonce + QStringLiteral(".sqlite");
  if (!key(from) || !key(to) || !key(nonce) || current(root) != to ||
      activation.value(QStringLiteral("backup")).toString() != backupName)
    fail(QStringLiteral("The recovery record does not match the current installation."));
  const auto backup = root + QLatin1Char('/') + backupName;
  if (digest(backup) != activation.value(QStringLiteral("backupSha256")).toString().toLatin1())
    fail(QStringLiteral("The recovery backup checksum does not match. No profile files were changed."));
  checkDatabase(backup);
  verifyBundle(root + QStringLiteral("/versions/") + from);
  const auto database = profileName + QStringLiteral("/watchpair-v2.sqlite");
  for (const auto &suffix : {QString(), QStringLiteral("-wal"), QStringLiteral("-shm")})
    if (QFileInfo::exists(database + suffix) &&
        !QFileInfo::exists(root + QStringLiteral("/backups/failed-") + nonce + QStringLiteral(".sqlite") +
                           suffix))
      copy(database + suffix,
           root + QStringLiteral("/backups/failed-") + nonce + QStringLiteral(".sqlite") + suffix);
  for (const auto &suffix : {QStringLiteral("-wal"), QStringLiteral("-shm")})
    if (QFileInfo::exists(database + suffix) && !QFile::remove(database + suffix))
      fail(QStringLiteral("Cannot release the stopped profile's journal files. Close other applications and "
                          "retry recovery."));
  copy(backup, database, activation.value(QStringLiteral("backupSha256")).toString().toLatin1());
  save(root + QStringLiteral("/current.txt"), from.toLatin1() + '\n');
  QFile::remove(root + QStringLiteral("/pending.txt"));
  QFile::remove(root + QStringLiteral("/attempt.txt"));
  QFile::remove(root + QStringLiteral("/previous.txt"));
  QFile::rename(root + QStringLiteral("/last-activation.json"),
                root + QStringLiteral("/backups/rolled-back-") + nonce + QStringLiteral(".json"));
}
void markHealthy() {
  const auto root = runningRoot();
  if (root.isEmpty() || !QFileInfo::exists(root + QStringLiteral("/pending.txt")))
    return;
  const auto lines = read(root + QStringLiteral("/pending.txt"), 512).split('\n');
  if (lines.size() != 4 || QString::fromLatin1(lines[1]) != QFileInfo(bundleRoot()).fileName())
    return;
  save(root + QStringLiteral("/healthy.txt"), lines[2] + '\n');
  QFile::remove(root + QStringLiteral("/pending.txt"));
  QFile::remove(root + QStringLiteral("/attempt.txt"));
}
void waitForProcess(qint64 pid) {
  if (pid <= 0)
    return;
#ifdef Q_OS_WIN
  const auto handle = OpenProcess(SYNCHRONIZE, FALSE, DWORD(pid));
  if (!handle)
    return;
  const auto result = WaitForSingleObject(handle, 60000);
  CloseHandle(handle);
  if (result == WAIT_TIMEOUT)
    fail(QStringLiteral("WatchPair did not stop within a minute. Close it and retry."));
#else
  for (int n = 0; n < 600; ++n) {
    if (kill(pid_t(pid), 0) < 0 && errno == ESRCH)
      return;
    QThread::msleep(100);
  }
  fail(QStringLiteral("WatchPair did not stop within a minute. Close it and retry."));
#endif
}
} // namespace wp::delivery
namespace wp {
ReleaseManager::ReleaseManager(LocalStore &store, TransferEngine &transfers, QObject *parent)
    : QObject(parent), store_(store), transfers_(transfers) {
  pool_.setMaxThreadCount(1);
  route_ = transfers_.configuration();
  connect(&transfers_, &TransferEngine::changed, this, [this] {
    const auto next = transfers_.configuration();
    for (const auto &field : {QStringLiteral("bind"), QStringLiteral("proxyHost"),
                              QStringLiteral("proxyPort"), QStringLiteral("offline")})
      if (route_.value(field) != next.value(field))
        cancel();
    route_ = next;
  });
  status_ = QStringLiteral("Version %1").arg(QCoreApplication::applicationVersion());
}
ReleaseManager::~ReleaseManager() {
  cancel();
  pool_.waitForDone();
  transfers_.setExternalTrafficFor(QStringLiteral("updates"), 0);
}
QString ReleaseManager::root() const {
  return store_.setting(QStringLiteral("installationRoot")).toString();
}
bool ReleaseManager::canUpdate() const {
  return QByteArray::fromHex(WATCHPAIR_UPDATE_PUBLIC_KEY).size() == 32;
}
bool ReleaseManager::canRollback() const {
  return !root().isEmpty() && QFileInfo::exists(root() + QStringLiteral("/last-activation.json"));
}
bool ReleaseManager::staged() const {
  return !root().isEmpty() && QFileInfo::exists(root() + QStringLiteral("/staged.json"));
}
HttpOptions ReleaseManager::network(const QUrl &url) const {
  const auto c = transfers_.configuration();
  if (c.value(QStringLiteral("offline")).toBool())
    throw AppError(QStringLiteral("OFFLINE"),
                   QStringLiteral("Resume network transfers before checking updates."));
  HttpOptions options;
  options.url = url;
  options.bindAddress = c.value(QStringLiteral("bind")).toString();
  options.proxyHost = c.value(QStringLiteral("proxyHost")).toString();
  options.proxyPort = c.value(QStringLiteral("proxyPort")).toInt(1080);
  options.control = control_;
  options.allowPrivate = true;
  return options;
}
void ReleaseManager::task(const std::function<QString()> &work, const std::function<void()> &success) {
  if (busy_)
    throw AppError(QStringLiteral("DELIVERY_BUSY"),
                   QStringLiteral("Wait for the current installation task or cancel its download."));
  busy_ = true;
  transfers_.setExternalTrafficFor(QStringLiteral("updates"), control_ ? 1 : 0);
  emit changed();
  auto *watcher = new QFutureWatcher<QString>(this);
  connect(watcher, &QFutureWatcher<QString>::finished, this, [this, watcher, success] {
    busy_ = false;
    transfers_.setExternalTrafficFor(QStringLiteral("updates"), 0);
    const auto error = watcher->result();
    watcher->deleteLater();
    if (error.isEmpty()) {
      try {
        success();
      } catch (const AppError &e) {
        status_ = e.message();
        emit problem(e.code(), status_);
      }
    } else {
      status_ = error;
      emit problem(QStringLiteral("APPLICATION_DELIVERY"), error);
    }
    emit changed();
  });
  watcher->setFuture(QtConcurrent::run(&pool_, [work] {
    try {
      return work();
    } catch (const std::exception &e) {
      return QString::fromUtf8(e.what());
    }
  }));
}
void ReleaseManager::install(const QString &directory) {
  if (busy_)
    throw AppError(QStringLiteral("DELIVERY_BUSY"),
                   QStringLiteral("Wait for the current installation task."));
  control_.reset();
  const auto bundle = delivery::bundleRoot(), profile = store_.profile();
  auto result = std::make_shared<QJsonObject>();
  status_ = QStringLiteral("Verifying and installing this application copy…");
  task(
      [bundle, directory, profile, result] {
        *result = delivery::installBundle(bundle, directory, profile);
        return QString();
      },
      [this, result] {
        store_.setSetting(QStringLiteral("installationRoot"), result->value(QStringLiteral("root")));
        store_.setSetting(QStringLiteral("installationIntegrationPending"), true);
        status_ = QStringLiteral("Installed. Restart to use this private installation.");
      });
}
void ReleaseManager::check(const QUrl &feed) {
  if (busy_)
    throw AppError(QStringLiteral("DELIVERY_BUSY"),
                   QStringLiteral("Wait for the current installation task."));
  if (!canUpdate())
    throw AppError(QStringLiteral("UPDATE_KEY"),
                   QStringLiteral("This development build has no pinned release key. Install a signed "
                                  "release bundle to enable updates."));
  if (feed.scheme() != QStringLiteral("https") &&
      !(feed.scheme() == QStringLiteral("http") && feed.host() == QStringLiteral("127.0.0.1")))
    throw AppError(QStringLiteral("UPDATE_URL"), QStringLiteral("The update feed must use HTTPS."));
  control_ = std::make_shared<HttpControl>();
  control_->budget = transfers_.downloadBudget();
  auto options = network(feed);
  options.maximumBytes = 128 * 1024;
  auto release = std::make_shared<delivery::Release>();
  const auto current = QCoreApplication::applicationVersion();
  release_ = {};
  status_ = QStringLiteral("Checking the signed release feed…");
  task(
      [options, release, current] {
        const auto result = fetchHttp(options);
        if (result.cancelled)
          return QStringLiteral("Update check cancelled.");
        if (result.status != 200 && result.status > 0)
          return QStringLiteral("The update feed returned HTTP %1. Check the update feed address.")
              .arg(result.status);
        if (!result.error.isEmpty())
          return QStringLiteral("The update feed could not be downloaded. %1").arg(result.error);
        *release = delivery::verifyFeed(result.body, QByteArray::fromHex(WATCHPAIR_UPDATE_PUBLIC_KEY),
                                        current, false);
        return QString();
      },
      [this, release, current] {
        if (delivery::compareVersions(release->version, current) > 0) {
          release_ = *release;
          status_ = QStringLiteral("Version %1 is available. %2").arg(release_.version, release_.notes);
        } else {
          status_ = QStringLiteral("You're up to date. Installed version: %1.").arg(current);
        }
      });
}
void ReleaseManager::download() {
  if (busy_)
    throw AppError(QStringLiteral("DELIVERY_BUSY"),
                   QStringLiteral("Wait for the current installation task."));
  if (!available() || root().isEmpty())
    throw AppError(QStringLiteral("UPDATE_INSTALL"),
                   QStringLiteral("Install this copy and check for a signed release first."));
  control_ = std::make_shared<HttpControl>();
  control_->budget = transfers_.downloadBudget();
  auto options = network(release_.url);
  const auto release = release_;
  const auto directory = root(), profile = store_.profile();
  status_ = QStringLiteral("Downloading and verifying version %1…").arg(release.version);
  task(
      [options, release, directory, profile]() mutable {
        QTemporaryDir temporary(directory + QStringLiteral("/.download-XXXXXX"));
        if (!temporary.isValid())
          return QStringLiteral("Cannot create private update staging.");
        options.destination = temporary.filePath(QStringLiteral("package"));
        options.maximumBytes = release.size;
        const auto result = fetchHttp(options);
        if (result.cancelled)
          return QStringLiteral("Update download cancelled.");
        if (!result.error.isEmpty() || result.status != 200 ||
            QFileInfo(options.destination).size() != release.size)
          return QStringLiteral("The update download is incomplete. Retry when the connection is available.");
        if (delivery::digest(options.destination) != release.sha256.toLatin1())
          return QStringLiteral("The signed package checksum did not match. The release was rejected.");
        const auto unpacked = temporary.filePath(QStringLiteral("unpacked"));
        delivery::extractArchive(options.destination, unpacked);
        delivery::verifyBundle(unpacked, release.version);
        delivery::installBundle(unpacked, directory, profile);
        return QString();
      },
      [this] {
        status_ =
            QStringLiteral("The verified update is ready. Restart when you are ready to leave the watch.");
      });
}
void ReleaseManager::cancel() {
  if (control_)
    control_->cancelled.store(true);
}
void ReleaseManager::restart(bool restore) {
  if (busy_ || root().isEmpty())
    throw AppError(QStringLiteral("DELIVERY_BUSY"), QStringLiteral("Finish installation before restarting."));
  if (restore && !canRollback())
    throw AppError(QStringLiteral("UPDATE_BACKUP"),
                   QStringLiteral("No previous version and profile backup are available."));
  emit restartRequested(root(), restore    ? QStringLiteral("rollback")
                                : staged() ? QStringLiteral("activate")
                                           : QStringLiteral("installed"));
}
} // namespace wp
