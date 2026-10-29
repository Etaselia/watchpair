#pragma once
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QTcpServer>
#include <QUdpSocket>
#include <clocale>
#include <stdexcept>

namespace wp {
inline void configureNativeRuntime() {
  // QApplication adopts the user's C locale during construction. libmpv
  // requires C numeric parsing before mpv_create(), including on desktops
  // whose numbers use a decimal comma. Qt's QLocale retains user formatting.
  std::setlocale(LC_NUMERIC, "C");
#ifdef Q_OS_WIN
  // Providers are dynamically loaded and absent from DLL import tables.
  const auto modules = QCoreApplication::applicationDirPath() + QStringLiteral("/ossl-modules");
  if (QDir(modules).exists() && !qEnvironmentVariableIsSet("OPENSSL_MODULES"))
    qputenv("OPENSSL_MODULES", QFile::encodeName(modules));
#endif
}
inline std::string torrentListenInterface(bool localOnly) {
#ifdef Q_OS_WIN
  // libtorrent binds TCP first, then UDP to the same port. Windows can assign
  // a TCP ephemeral port that is reserved for UDP (notably with Hyper-V/WSL).
  // Choose a port available to both protocols without changing OS exclusions.
  const QHostAddress address(localOnly ? QHostAddress::LocalHost : QHostAddress::AnyIPv4);
  for (int attempt = 0; attempt < 32; ++attempt) {
    QUdpSocket udp;
    if (!udp.bind(address, 0, QAbstractSocket::DontShareAddress))
      continue;
    QTcpServer tcp;
    if (tcp.listen(address, udp.localPort()))
      return (address.toString() + QLatin1Char(':') + QString::number(udp.localPort())).toStdString();
  }
  throw std::runtime_error("Cannot allocate a torrent port available to both TCP and UDP.");
#else
  return localOnly ? "127.0.0.1:0" : "0.0.0.0:0";
#endif
}
} // namespace wp
