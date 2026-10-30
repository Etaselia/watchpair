#pragma once
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QRandomGenerator>
#include <QTcpServer>
#include <QTcpSocket>
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
  // UDP's allocator can also return hundreds of consecutive TCP exclusions.
  // Spread probes across high ports instead of relying on either allocator.
  const QHostAddress address(localOnly ? QHostAddress::LocalHost : QHostAddress::AnyIPv4);
  auto available = [&](quint16 first, quint32 count, quint32 stride) -> quint16 {
    const auto start = QRandomGenerator::system()->bounded(count);
    for (quint32 attempt = 0; attempt < 128; ++attempt) {
      const auto port = quint16(first + (start + attempt * stride) % count);
      QTcpSocket tcp;
      if (!tcp.bind(address, port, QAbstractSocket::DontShareAddress))
        continue;
      QUdpSocket udp;
      if (udp.bind(address, port, QAbstractSocket::DontShareAddress))
        return port;
    }
    return 0;
  };
  // Odd strides visit distinct ports in these power-of-two ranges.
  auto port = available(49152, 16384, 10127);
  if (!port)
    port = available(16384, 32768, 20249);
  if (port)
    return (address.toString() + QLatin1Char(':') + QString::number(port)).toStdString();
  throw std::runtime_error("Cannot allocate a torrent port available to both TCP and UDP.");
#else
  return localOnly ? "127.0.0.1:0" : "0.0.0.0:0";
#endif
}
} // namespace wp
