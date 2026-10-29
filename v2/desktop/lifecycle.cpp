#include "lifecycle.h"
#include "profile_security.h"
#include "release_manager.h"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QElapsedTimer>
#include <QFileInfo>
#include <QJsonDocument>
#include <QLocalSocket>
#include <QProcess>
#include <QRandomGenerator>
#include <QSaveFile>
#include <QSettings>
#include <QStandardPaths>
#include <QTimer>
#ifdef Q_OS_WIN
#include <windows.h>

#include <shobjidl.h>
#endif
namespace wp {
SingleInstance::SingleInstance(const QString &profile, QObject *parent)
    : QObject(parent), profile_(QDir(profile).absolutePath()) {
  secureProfile(profile_);
  profile_ = QDir(profile_).canonicalPath();
  name_ = QStringLiteral("watchpair-v2-") +
          QString::fromLatin1(
              QCryptographicHash::hash(profile_.toUtf8(), QCryptographicHash::Sha256).toHex().left(32));
  lock_ = std::make_unique<QLockFile>(profile_ + QStringLiteral("/instance.lock"));
  server_.setSocketOptions(QLocalServer::UserAccessOption);
  connect(&server_, &QLocalServer::newConnection, this, [this] {
    while (server_.hasPendingConnections()) {
      auto *socket = server_.nextPendingConnection();
      socket->setReadBufferSize(32768);
      auto data = std::make_shared<QByteArray>();
      QTimer::singleShot(2000, socket, &QLocalSocket::abort);
      connect(socket, &QLocalSocket::disconnected, socket, &QObject::deleteLater);
      connect(socket, &QLocalSocket::readyRead, socket, [this, socket, data] {
        data->append(socket->readAll());
        if (data->size() > 16384) {
          socket->abort();
          return;
        }
        if (!data->endsWith('\n'))
          return;
        const auto message = QJsonDocument::fromJson(*data).object();
        const auto link = message.value(QStringLiteral("link")).toString();
        if (message.value(QStringLiteral("v")).toInt() != 2 ||
            message.value(QStringLiteral("cookie")).toString().toLatin1() != cookie_ || link.size() > 12000 ||
            link.contains(QChar::Null)) {
          socket->abort();
          return;
        }
        socket->write("ok\n");
        socket->disconnectFromServer();
        emit activate(link);
      });
    }
  });
}
SingleInstance::~SingleInstance() {
  server_.close();
  if (lock_->isLocked())
    lock_->unlock();
}
bool SingleInstance::acquireOrForward(const QString &link) {
  const auto path = profile_ + QStringLiteral("/instance.secret");
  if (lock_->tryLock()) {
    cookie_.resize(64);
    static const char hex[] = "0123456789abcdef";
    for (int i = 0; i < 64; ++i)
      cookie_[i] = hex[QRandomGenerator::system()->bounded(16)];
    QSaveFile file(path);
    if (!file.open(QIODevice::WriteOnly))
      throw AppError(QStringLiteral("INSTANCE_ACCESS"),
                     QStringLiteral("Cannot protect the desktop session."));
    file.setPermissions(QFile::ReadOwner | QFile::WriteOwner);
    if (file.write(cookie_) != cookie_.size() || !file.commit())
      throw AppError(QStringLiteral("INSTANCE_ACCESS"),
                     QStringLiteral("Cannot save the desktop session identity."));
    QLocalServer::removeServer(name_);
    if (!server_.listen(name_))
      throw AppError(QStringLiteral("INSTANCE_LISTENER"),
                     QStringLiteral("Cannot create the private desktop session listener."));
    return true;
  }
  QFile file(path);
  if (!file.open(QIODevice::ReadOnly) || file.size() != 64)
    throw AppError(
        QStringLiteral("INSTANCE_BUSY"),
        QStringLiteral("WatchPair is starting or closing. Wait a moment and open the invite again."));
  const auto cookie = file.readAll();
  QLocalSocket socket;
  socket.connectToServer(name_);
  if (!socket.waitForConnected(3000))
    throw AppError(
        QStringLiteral("INSTANCE_BUSY"),
        QStringLiteral(
            "The existing WatchPair session is not responding. Close it before reopening this profile."));
  const auto bytes = QJsonDocument(QJsonObject{{QStringLiteral("v"), 2},
                                               {QStringLiteral("cookie"), QString::fromLatin1(cookie)},
                                               {QStringLiteral("link"), link}})
                         .toJson(QJsonDocument::Compact) +
                     '\n';
  socket.write(bytes);
  if (socket.bytesToWrite() > 0 && !socket.waitForBytesWritten(2000))
    throw AppError(QStringLiteral("INSTANCE_BUSY"),
                   QStringLiteral("The existing desktop session could not accept this invite."));
  QByteArray ack;
  QElapsedTimer timeout;
  timeout.start();
  while (!ack.endsWith('\n') && ack.size() < 16 && timeout.elapsed() < 3000) {
    if (!socket.bytesAvailable() && !socket.waitForReadyRead(int(3000 - timeout.elapsed())))
      break;
    ack.append(socket.readAll());
  }
  if (ack != "ok\n")
    throw AppError(
        QStringLiteral("INSTANCE_BUSY"),
        QStringLiteral("The existing desktop session could not accept this invite. Open it there manually."));
  return false;
}
namespace desktop {
namespace {
QString escaped(QString path) {
  path.replace(QLatin1Char('\\'), QStringLiteral("\\\\"));
  path.replace(QLatin1Char('"'), QStringLiteral("\\\""));
  path.replace(QLatin1Char('`'), QStringLiteral("\\`"));
  path.replace(QLatin1Char('$'), QStringLiteral("\\$"));
  path.replace(QLatin1Char('%'), QStringLiteral("%%"));
  return path;
}
void save(const QString &path, const QByteArray &bytes) {
  if (!QDir().mkpath(QFileInfo(path).absolutePath()))
    throw AppError(QStringLiteral("DESKTOP_INTEGRATION"),
                   QStringLiteral("Cannot create the desktop integration folder."));
  QSaveFile file(path);
  if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size() || !file.commit())
    throw AppError(QStringLiteral("DESKTOP_INTEGRATION"), QStringLiteral("Cannot save desktop integration."));
}
} // namespace
QString desktopEntry(const QString &executable, bool startup) {
  return QStringLiteral("[Desktop Entry]\nType=Application\nName=WatchPair\nComment=Watch together with your "
                        "own video copy\nExec=\"%1\" "
                        "%2\nIcon=watchpair\nTerminal=false\nCategories=AudioVideo;Video;Network;\nMimeType="
                        "x-scheme-handler/watchpair;\nStartupNotify=true\n")
      .arg(escaped(executable), startup ? QStringLiteral("--background") : QStringLiteral("%u"));
}
QString executable() {
  const auto installed = delivery::runningRoot();
  if (!installed.isEmpty() && QFileInfo::exists(delivery::launcher(installed)))
    return delivery::launcher(installed);
#ifndef Q_OS_WIN
  const auto wrapper =
      QDir(QCoreApplication::applicationDirPath()).absoluteFilePath(QStringLiteral("../AppRun"));
  if (QFileInfo(wrapper).isExecutable() && !QFileInfo(wrapper).isSymLink())
    return QFileInfo(wrapper).canonicalFilePath();
#endif
  return QCoreApplication::applicationFilePath();
}
void registerProtocol() {
  const auto exe = QDir::toNativeSeparators(executable());
#ifdef Q_OS_WIN
  QSettings settings(QStringLiteral("HKEY_CURRENT_USER\\Software\\Classes\\watchpair"),
                     QSettings::NativeFormat);
  settings.setValue(QStringLiteral("."), QStringLiteral("URL:WatchPair private room"));
  settings.setValue(QStringLiteral("URL Protocol"), QString());
  settings.setValue(QStringLiteral("DefaultIcon/."), QStringLiteral("\"%1\",0").arg(exe));
  settings.setValue(QStringLiteral("shell/open/command/."),
                    QStringLiteral("\"%1\" \"%2\"").arg(exe, QStringLiteral("%1")));
  settings.sync();
  if (settings.status() != QSettings::NoError)
    throw AppError(QStringLiteral("DESKTOP_INTEGRATION"),
                   QStringLiteral("Cannot register private invite links for this Windows account."));
#else
  const auto path = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation) +
                    QStringLiteral("/applications/watchpair.desktop");
  save(path, desktopEntry(exe).toUtf8());
  const int result = QProcess::execute(QStringLiteral("xdg-mime"),
                                       {QStringLiteral("default"), QStringLiteral("watchpair.desktop"),
                                        QStringLiteral("x-scheme-handler/watchpair")});
  if (result != 0)
    throw AppError(QStringLiteral("DESKTOP_INTEGRATION"),
                   QStringLiteral("The desktop entry was saved, but your desktop could not register invite "
                                  "links. Use Join room to paste an invite."));
#endif
}
void installShortcut() {
#ifdef Q_OS_WIN
  const auto folder = QStandardPaths::writableLocation(QStandardPaths::ApplicationsLocation);
  if (folder.isEmpty() || !QDir().mkpath(folder))
    throw AppError(QStringLiteral("DESKTOP_INTEGRATION"),
                   QStringLiteral("Cannot access your Start menu folder."));
  const auto initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  IShellLinkW *link = nullptr;
  HRESULT result = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_IShellLinkW,
                                    reinterpret_cast<void **>(&link));
  if (SUCCEEDED(result)) {
    const auto exe = QDir::toNativeSeparators(executable()).toStdWString();
    result = link->SetPath(exe.c_str());
    if (SUCCEEDED(result))
      result = link->SetDescription(L"Watch together with your own video copy");
    IPersistFile *file = nullptr;
    if (SUCCEEDED(result))
      result = link->QueryInterface(IID_IPersistFile, reinterpret_cast<void **>(&file));
    if (SUCCEEDED(result)) {
      const auto path = QDir::toNativeSeparators(folder + QStringLiteral("/WatchPair.lnk")).toStdWString();
      result = file->Save(path.c_str(), TRUE);
      file->Release();
    }
    link->Release();
  }
  if (SUCCEEDED(initialized))
    CoUninitialize();
  if (FAILED(result))
    throw AppError(QStringLiteral("DESKTOP_INTEGRATION"),
                   QStringLiteral("Could not create your WatchPair Start menu shortcut."));
#else
  // registerProtocol also installs the desktop application entry.
  const auto icon = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation) +
                    QStringLiteral("/icons/hicolor/scalable/apps/watchpair.svg");
  const auto source = delivery::bundleRoot() + QStringLiteral("/watchpair.svg");
  QFile file(source);
  if (file.open(QIODevice::ReadOnly))
    save(icon, file.readAll());
#endif
}
void startAtLogin(bool enabled) {
#ifdef Q_OS_WIN
  QSettings settings(QStringLiteral("HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"),
                     QSettings::NativeFormat);
  if (enabled)
    settings.setValue(QStringLiteral("WatchPair"),
                      QStringLiteral("\"%1\" --background").arg(QDir::toNativeSeparators(executable())));
  else
    settings.remove(QStringLiteral("WatchPair"));
  settings.sync();
  if (settings.status() != QSettings::NoError)
    throw AppError(QStringLiteral("DESKTOP_INTEGRATION"),
                   QStringLiteral("Cannot change startup for this Windows account."));
#else
  const auto path = QStandardPaths::writableLocation(QStandardPaths::GenericConfigLocation) +
                    QStringLiteral("/autostart/watchpair.desktop");
  if (enabled)
    save(path, desktopEntry(executable(), true).toUtf8());
  else if (QFileInfo::exists(path) && !QFile::remove(path))
    throw AppError(QStringLiteral("DESKTOP_INTEGRATION"),
                   QStringLiteral("Cannot remove the WatchPair startup entry."));
#endif
}
} // namespace desktop
} // namespace wp
