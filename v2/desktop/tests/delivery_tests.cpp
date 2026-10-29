#include "release_manager.h"
#include "transfer_engine.h"
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QLockFile>
#include <QProcess>
#include <QProcessEnvironment>
#include <QScopeGuard>
#include <QSqlQuery>
#include <QTemporaryDir>
#include <QtTest>
#include <archive.h>
#include <archive_entry.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
namespace {
void write(const QString &path, const QByteArray &data) {
  if (!QDir().mkpath(QFileInfo(path).path()))
    throw std::runtime_error("fixture mkdir");
  QFile file(path);
  if (!file.open(QIODevice::WriteOnly) || file.write(data) != data.size())
    throw std::runtime_error("fixture write");
}
QByteArray read(const QString &path) {
  QFile file(path);
  if (!file.open(QIODevice::ReadOnly))
    throw std::runtime_error("fixture read");
  return file.readAll();
}
QString bundle(const QString &root, const QString &name, const QString &version) {
  const auto path = root + QLatin1Char('/') + name;
  const QStringList names =
      wp::delivery::platform() == QStringLiteral("windows-x64")
          ? QStringList{QStringLiteral("watchpair.exe"), QStringLiteral("watchpair-launcher.exe"),
                        QStringLiteral("licenses/notice.txt")}
          : QStringList{QStringLiteral("AppRun"), QStringLiteral("watchpair-launcher"),
                        QStringLiteral("licenses/notice.txt")};
  QJsonArray files;
  for (const auto &name : names) {
    const auto data = (version + name).toUtf8();
    write(path + QLatin1Char('/') + name, data);
    files.append(QJsonObject{
        {QStringLiteral("path"), name},
        {QStringLiteral("size"), data.size()},
        {QStringLiteral("sha256"),
         QString::fromLatin1(QCryptographicHash::hash(data, QCryptographicHash::Sha256).toHex())}});
  }
  write(path + QStringLiteral("/runtime-manifest.json"),
        QJsonDocument(QJsonObject{{QStringLiteral("format"), 1},
                                  {QStringLiteral("version"), version},
                                  {QStringLiteral("protocol"), 2},
                                  {QStringLiteral("platform"), wp::delivery::platform()},
                                  {QStringLiteral("files"), files}})
            .toJson());
  return path;
}
struct Signer {
  std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key{nullptr, EVP_PKEY_free};
  QByteArray publicKey;
  Signer() {
    QByteArray secret(32, Qt::Uninitialized);
    if (RAND_bytes(reinterpret_cast<unsigned char *>(secret.data()), 32) != 1)
      throw std::runtime_error("random key");
    key.reset(EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, nullptr,
                                           reinterpret_cast<unsigned char *>(secret.data()), 32));
    publicKey.resize(32);
    size_t length = 32;
    if (!key || EVP_PKEY_get_raw_public_key(key.get(), reinterpret_cast<unsigned char *>(publicKey.data()),
                                            &length) != 1)
      throw std::runtime_error("public key");
  }
  QByteArray sign(const QJsonObject &document) const {
    const auto payload = QJsonDocument(document).toJson(QJsonDocument::Compact);
    std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context(EVP_MD_CTX_new(), EVP_MD_CTX_free);
    QByteArray signature(64, Qt::Uninitialized);
    size_t length = 64;
    if (EVP_DigestSignInit(context.get(), nullptr, nullptr, nullptr, key.get()) != 1 ||
        EVP_DigestSign(context.get(), reinterpret_cast<unsigned char *>(signature.data()), &length,
                       reinterpret_cast<const unsigned char *>(payload.data()), payload.size()) != 1)
      throw std::runtime_error("signature");
    return QJsonDocument(
               QJsonObject{{QStringLiteral("payload"), QString::fromLatin1(payload.toBase64())},
                           {QStringLiteral("signature"), QString::fromLatin1(signature.toBase64())}})
        .toJson();
  }
};
void writeArchive(const QString &path, const QStringList &names, bool symlink = false) {
  auto *out = archive_write_new();
  archive_write_set_format_pax_restricted(out);
#ifdef Q_OS_WIN
  const auto result = archive_write_open_filename_w(out, reinterpret_cast<const wchar_t *>(path.utf16()));
#else
  const auto result = archive_write_open_filename(out, QFile::encodeName(path).constData());
#endif
  if (result != ARCHIVE_OK)
    throw std::runtime_error("archive create");
  for (const auto &name : names) {
    auto *entry = archive_entry_new();
    archive_entry_set_pathname_utf8(entry, name.toUtf8().constData());
    archive_entry_set_filetype(entry, symlink ? AE_IFLNK : AE_IFREG);
    archive_entry_set_size(entry, symlink ? 0 : 4);
    archive_entry_set_perm(entry, 0644);
    if (symlink)
      archive_entry_set_symlink(entry, "../external");
    if (archive_write_header(out, entry) != ARCHIVE_OK)
      throw std::runtime_error("archive header");
    if (!symlink)
      archive_write_data(out, "data", 4);
    archive_entry_free(entry);
  }
  archive_write_close(out);
  archive_write_free(out);
}
} // namespace
class DeliveryTests final : public QObject {
  Q_OBJECT
private slots:
  void packagedInstallationLaunchAndAutomaticCrashRollback() {
    const auto candidate = QString::fromLocal8Bit(qgetenv("WATCHPAIR_PACKAGE"));
    const auto previous = QString::fromLocal8Bit(qgetenv("WATCHPAIR_PREVIOUS_PACKAGE"));
    if (candidate.isEmpty() || previous.isEmpty())
      QSKIP("Set WATCHPAIR_PACKAGE and WATCHPAIR_PREVIOUS_PACKAGE for the packaged delivery pass");
    QTemporaryDir tmp;
    const auto profile = tmp.filePath(QStringLiteral("profile")),
               root = tmp.filePath(QStringLiteral("installed"));
    {
      wp::LocalStore store(profile);
      store.setSetting(QStringLiteral("installationRoot"), root);
      store.setSetting(QStringLiteral("packageProbe"), QStringLiteral("before-update"));
    }
    const auto baseline = wp::delivery::installBundle(previous, root, profile);
    auto launch = [&](const QString &screenshot) {
      QProcess process;
      auto environment = QProcessEnvironment::systemEnvironment();
#ifdef Q_OS_WIN
      environment.insert(QStringLiteral("Path"), qEnvironmentVariable("SystemRoot") +
                                                     QStringLiteral("/System32;") +
                                                     qEnvironmentVariable("SystemRoot"));
      environment.remove(QStringLiteral("QT_PLUGIN_PATH"));
      environment.remove(QStringLiteral("OPENSSL_MODULES"));
#endif
      process.setProcessEnvironment(environment);
      process.start(wp::delivery::launcher(root),
                    {QStringLiteral("--non-interactive"), QStringLiteral("--local-only"),
                     QStringLiteral("--exit-after"), QStringLiteral("4000"), QStringLiteral("--screenshot"),
                     screenshot});
      if (!process.waitForFinished(5000) || process.exitCode() != 0)
        return false;
      QElapsedTimer clock;
      clock.start();
      while (!QFileInfo::exists(screenshot) && clock.elapsed() < 20000)
        QTest::qWait(50);
      while (QFileInfo::exists(profile + QStringLiteral("/instance.lock")) && clock.elapsed() < 25000)
        QTest::qWait(50);
      return QFileInfo::exists(screenshot) && !QFileInfo::exists(profile + QStringLiteral("/instance.lock"));
    };
    QVERIFY2(launch(tmp.filePath(QStringLiteral("baseline.png"))),
             "The baseline package did not launch independently of the development SDK");
    const auto staged = wp::delivery::installBundle(candidate, root, profile);
    QVERIFY(staged.value(QStringLiteral("key")) != baseline.value(QStringLiteral("key")));
    wp::delivery::activate(root);
    // Simulate a verified new version dying before its healthy checkpoint.
    // Only this test-owned installed binary is replaced; the prior bundle and
    // its recovery helper remain intact.
#ifdef Q_OS_WIN
    const auto app = root + QStringLiteral("/versions/") + staged.value(QStringLiteral("key")).toString() +
                     QStringLiteral("/watchpair.exe");
    const auto child = QCoreApplication::applicationDirPath() + QStringLiteral("/delivery-crash-child.exe");
#else
    const auto app = root + QStringLiteral("/versions/") + staged.value(QStringLiteral("key")).toString() +
                     QStringLiteral("/bin/watchpair");
    const auto child = QCoreApplication::applicationDirPath() + QStringLiteral("/delivery-crash-child");
#endif
    QVERIFY(QFile::remove(app));
    QVERIFY(QFile::copy(child, app));
    QFile::setPermissions(app, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner);
    QProcess crash;
    crash.start(wp::delivery::launcher(root), QStringList{});
    QVERIFY(crash.waitForFinished(5000));
    QTRY_VERIFY_WITH_TIMEOUT(QFileInfo::exists(root + QStringLiteral("/attempt.txt")), 5000);
    QTest::qWait(500);
    {
      wp::LocalStore newer(profile);
      newer.setSetting(QStringLiteral("packageProbe"), QStringLiteral("new-version-state"));
    }
    QVERIFY2(launch(tmp.filePath(QStringLiteral("recovered.png"))),
             "The stable launcher did not restore the previous runtime and restart it");
    QCOMPARE(QString::fromUtf8(read(root + QStringLiteral("/current.txt"))).trimmed(),
             baseline.value(QStringLiteral("key")).toString());
    wp::LocalStore restored(profile);
    QCOMPARE(restored.setting(QStringLiteral("packageProbe")).toString(), QStringLiteral("before-update"));
    QVERIFY(!QFileInfo::exists(root + QStringLiteral("/pending.txt")));
  }
  void releaseSignatureVersionProtocolAndUrlAreAuthoritative() {
    Signer trusted, wrong;
    QJsonObject document{
        {QStringLiteral("format"), 1},
        {QStringLiteral("version"), QStringLiteral("2.0.0-rc.2")},
        {QStringLiteral("protocol"), 2},
        {QStringLiteral("artifacts"),
         QJsonObject{
             {wp::delivery::platform(),
              QJsonObject{{QStringLiteral("url"), QStringLiteral("https://downloads.invalid/package.zip")},
                          {QStringLiteral("size"), 1234},
                          {QStringLiteral("sha256"), QString(64, QLatin1Char('a'))}}}}}};
    const auto signedFeed = trusted.sign(document);
    QCOMPARE(wp::delivery::verifyFeed(signedFeed, trusted.publicKey, QStringLiteral("2.0.0-beta.99")).size,
             1234);
    QVERIFY_EXCEPTION_THROWN(
        wp::delivery::verifyFeed(signedFeed, wrong.publicKey, QStringLiteral("2.0.0-beta.99")), wp::AppError);
    QVERIFY_EXCEPTION_THROWN(wp::delivery::verifyFeed(signedFeed, trusted.publicKey, QStringLiteral("2.0.0")),
                             wp::AppError);
    auto altered = QJsonDocument::fromJson(signedFeed).object();
    auto bytes = QByteArray::fromBase64(altered.value(QStringLiteral("payload")).toString().toLatin1());
    bytes[bytes.size() / 2] ^= 1;
    altered.insert(QStringLiteral("payload"), QString::fromLatin1(bytes.toBase64()));
    QVERIFY_EXCEPTION_THROWN(wp::delivery::verifyFeed(QJsonDocument(altered).toJson(), trusted.publicKey,
                                                      QStringLiteral("2.0.0-beta.99")),
                             wp::AppError);
    document.insert(QStringLiteral("protocol"), 3);
    QVERIFY_EXCEPTION_THROWN(
        wp::delivery::verifyFeed(trusted.sign(document), trusted.publicKey, QStringLiteral("2.0.0-beta.99")),
        wp::AppError);
    document.insert(QStringLiteral("protocol"), 2);
    document.insert(QStringLiteral("version"), QStringLiteral("../../bad"));
    QVERIFY_EXCEPTION_THROWN(
        wp::delivery::verifyFeed(trusted.sign(document), trusted.publicKey, QStringLiteral("2.0.0-beta.99")),
        wp::AppError);
    QCOMPARE(wp::delivery::compareVersions(QStringLiteral("2.0.0"), QStringLiteral("2.0.0-rc.999")), 1);
  }
  void signedFeedDownloadsVerifiesAndStagesTheRealPackage() {
    const auto feed = qEnvironmentVariable("WATCHPAIR_UPDATE_TEST_FEED");
    const auto previous = qEnvironmentVariable("WATCHPAIR_PREVIOUS_PACKAGE");
    if (feed.isEmpty() || previous.isEmpty())
      QSKIP("Use scripts/test-release-update.mjs for the signed package transport pass");
    QTemporaryDir tmp;
    wp::LocalStore store(tmp.filePath(QStringLiteral("profile")));
    const auto root = tmp.filePath(QStringLiteral("runtime"));
    const auto baseline = wp::delivery::installBundle(previous, root, store.profile());
    store.setSetting(QStringLiteral("installationRoot"), root);
    const auto originalVersion = QCoreApplication::applicationVersion();
    const auto restoreVersion =
        qScopeGuard([&] { QCoreApplication::setApplicationVersion(originalVersion); });
    QCoreApplication::setApplicationVersion(baseline.value(QStringLiteral("version")).toString());
    wp::TransferEngine transfers(store, nullptr, true);
    wp::ReleaseManager updates(store, transfers);
    QSignalSpy problems(&updates, &wp::ReleaseManager::problem);
    QVERIFY2(updates.canUpdate(), "Build this QA binary with the matching public update key");
    updates.check(QUrl(feed));
    QTRY_VERIFY_WITH_TIMEOUT(!updates.busy(), 15000);
    QVERIFY2(problems.isEmpty(), qPrintable(updates.status()));
    QVERIFY(updates.available());
    updates.download();
    // Public mirrors and slower disks can exceed the loopback fixture budget.
    // Keep the default strict; operators may explicitly allow a bounded WAN wait.
    const auto downloadTimeout =
        qBound(90000, qEnvironmentVariableIntValue("WATCHPAIR_UPDATE_TEST_TIMEOUT_MS"), 600000);
    QTRY_VERIFY_WITH_TIMEOUT(!updates.busy(), downloadTimeout);
    QVERIFY2(problems.isEmpty(), qPrintable(updates.status()));
    QVERIFY(updates.staged());
    const auto staged = QJsonDocument::fromJson(read(root + QStringLiteral("/staged.json"))).object();
    const auto manifest = wp::delivery::verifyBundle(root + QStringLiteral("/versions/") +
                                                     staged.value(QStringLiteral("to")).toString());
    QCOMPARE(wp::delivery::compareVersions(manifest.value(QStringLiteral("version")).toString(),
                                           baseline.value(QStringLiteral("version")).toString()),
             1);
  }
  void archiveRejectsTraversalLinksDuplicateNamesAndDevicePaths() {
    QTemporaryDir tmp;
    int sequence = 0;
    for (const auto &names :
         {QStringList{QStringLiteral("../outside")}, QStringList{QStringLiteral("C:/outside")},
          QStringList{QStringLiteral("A.txt"), QStringLiteral("a.txt")},
          QStringList{QStringLiteral("NUL.txt")}, QStringList{QStringLiteral("safe/../../outside")}}) {
      const auto file = tmp.filePath(QStringLiteral("bad%1.tar").arg(sequence));
      writeArchive(file, names);
      QVERIFY_EXCEPTION_THROWN(
          wp::delivery::extractArchive(file, tmp.filePath(QStringLiteral("out%1").arg(sequence++))),
          wp::AppError);
      QVERIFY(!QFileInfo::exists(tmp.filePath(QStringLiteral("outside"))));
    }
    writeArchive(tmp.filePath(QStringLiteral("link.tar")), {QStringLiteral("link")}, true);
    QVERIFY_EXCEPTION_THROWN(wp::delivery::extractArchive(tmp.filePath(QStringLiteral("link.tar")),
                                                          tmp.filePath(QStringLiteral("links"))),
                             wp::AppError);
    writeArchive(tmp.filePath(QStringLiteral("ok.tar")), {QStringLiteral("sub/file.txt")});
    wp::delivery::extractArchive(tmp.filePath(QStringLiteral("ok.tar")),
                                 tmp.filePath(QStringLiteral("valid")));
    QCOMPARE(read(tmp.filePath(QStringLiteral("valid/sub/file.txt"))), QByteArray("data"));
  }
  void packageChecksumsAndForeignFoldersCannotBeBypassed() {
    QTemporaryDir tmp;
    const auto source = bundle(tmp.path(), QStringLiteral("bundle"), QStringLiteral("2.0.0"));
    wp::LocalStore store(tmp.filePath(QStringLiteral("profile")));
    write(tmp.filePath(QStringLiteral("foreign/sentinel")), "keep");
    QVERIFY_EXCEPTION_THROWN(
        wp::delivery::installBundle(source, tmp.filePath(QStringLiteral("foreign")), store.profile()),
        wp::AppError);
    QCOMPARE(read(tmp.filePath(QStringLiteral("foreign/sentinel"))), QByteArray("keep"));
    write(source + QStringLiteral("/licenses/notice.txt"), "modified");
    QVERIFY_EXCEPTION_THROWN(wp::delivery::verifyBundle(source), wp::AppError);
    const auto second = bundle(tmp.path(), QStringLiteral("second"), QStringLiteral("2.0.0"));
    write(second + QStringLiteral("/unlisted.dll"), "not in package");
    QVERIFY_EXCEPTION_THROWN(wp::delivery::verifyBundle(second), wp::AppError);
  }
  void activationAndRollbackRestoreTheCompatibleProfileAndPreserveFailedState() {
    QTemporaryDir tmp;
    const auto profile = tmp.filePath(QStringLiteral("profile")),
               root = tmp.filePath(QStringLiteral("runtime"));
    {
      wp::LocalStore store(profile);
      store.setSetting(QStringLiteral("privateCredential"), QStringLiteral("before-update"));
    }
    const auto first = wp::delivery::installBundle(
        bundle(tmp.path(), QStringLiteral("one"), QStringLiteral("2.0.0")), root, profile);
    wp::delivery::installBundle(bundle(tmp.path(), QStringLiteral("two"), QStringLiteral("2.1.0")), root,
                                profile);
    const auto old = read(root + QStringLiteral("/current.txt"));
    QLockFile lock(profile + QStringLiteral("/instance.lock"));
    QVERIFY(lock.tryLock());
    QVERIFY_EXCEPTION_THROWN(wp::delivery::activate(root), wp::AppError);
    QCOMPARE(read(root + QStringLiteral("/current.txt")), old);
    lock.unlock();
    wp::delivery::activate(root);
    QVERIFY(read(root + QStringLiteral("/current.txt")) != old);
    QVERIFY(QFileInfo::exists(root + QStringLiteral("/pending.txt")));
    {
      wp::LocalStore newer(profile);
      newer.setSetting(QStringLiteral("privateCredential"), QStringLiteral("after-update"));
      auto connection =
          QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), QStringLiteral("future-fixture"));
      connection.setDatabaseName(profile + QStringLiteral("/watchpair-v2.sqlite"));
      QVERIFY(connection.open());
      QSqlQuery query(connection);
      QVERIFY(query.exec(QStringLiteral("PRAGMA user_version=99")));
      connection.close();
    }
    QSqlDatabase::removeDatabase(QStringLiteral("future-fixture"));
    // Recovery deliberately runs before constructing LocalStore, which must
    // refuse a future schema. Both binary and schema return together.
    wp::delivery::rollback(root);
    QCOMPARE(read(root + QStringLiteral("/current.txt")), old);
    QVERIFY(!QFileInfo::exists(root + QStringLiteral("/pending.txt")));
    wp::LocalStore restored(profile);
    QCOMPARE(restored.setting(QStringLiteral("privateCredential")).toString(),
             QStringLiteral("before-update"));
    QVERIFY(!QDir(root + QStringLiteral("/backups"))
                 .entryList({QStringLiteral("failed-*.sqlite")}, QDir::Files)
                 .isEmpty());
    QVERIFY(QFileInfo::exists(wp::delivery::launcher(root)));
  }
  void damagedBackupDoesNotChangeTheCurrentProfile() {
    QTemporaryDir tmp;
    const auto profile = tmp.filePath(QStringLiteral("profile")),
               root = tmp.filePath(QStringLiteral("runtime"));
    {
      wp::LocalStore store(profile);
      store.setSetting(QStringLiteral("value"), 42);
    }
    wp::delivery::installBundle(bundle(tmp.path(), QStringLiteral("one"), QStringLiteral("2.0.0")), root,
                                profile);
    wp::delivery::installBundle(bundle(tmp.path(), QStringLiteral("two"), QStringLiteral("2.1.0")), root,
                                profile);
    wp::delivery::activate(root);
    const auto record =
        QJsonDocument::fromJson(read(root + QStringLiteral("/last-activation.json"))).object();
    write(root + QLatin1Char('/') + record.value(QStringLiteral("backup")).toString(), "corrupt");
    const auto before = read(profile + QStringLiteral("/watchpair-v2.sqlite"));
    QVERIFY_EXCEPTION_THROWN(wp::delivery::rollback(root), wp::AppError);
    QCOMPARE(read(profile + QStringLiteral("/watchpair-v2.sqlite")), before);
    wp::LocalStore unchanged(profile);
    QCOMPARE(unchanged.setting(QStringLiteral("value")).toInt(), 42);
  }
};
QTEST_GUILESS_MAIN(DeliveryTests)
#include "delivery_tests.moc"
