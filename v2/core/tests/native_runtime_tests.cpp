#include "native_runtime.h"
#include "player.h"
#include <QApplication>
#include <QLocale>
#include <QtTest>
#include <clocale>
#include <memory>
#include <vector>

class NativeRuntimeTests final : public QObject {
  Q_OBJECT
private slots:
#ifdef Q_OS_WIN
  void concurrentTorrentPortsRemainUsable_data() {
    QTest::addColumn<bool>("localOnly");
    QTest::newRow("loopback") << true;
    QTest::newRow("all-ipv4-interfaces") << false;
  }
  void concurrentTorrentPortsRemainUsable() {
    QFETCH(bool, localOnly);
    const QHostAddress address(localOnly ? QHostAddress::LocalHost : QHostAddress::AnyIPv4);
    std::vector<std::unique_ptr<QTcpSocket>> tcpSockets;
    std::vector<std::unique_ptr<QUdpSocket>> udpSockets;
    QSet<quint16> ports;
    try {
      for (int connection = 0; connection < 64; ++connection) {
        const auto endpoint = QString::fromStdString(wp::torrentListenInterface(localOnly));
        QCOMPARE(endpoint.section(QLatin1Char(':'), 0, 0), address.toString());
        const auto port = endpoint.section(QLatin1Char(':'), 1).toUShort();
        QVERIFY(port >= 16384);
        QVERIFY(!ports.contains(port));
        auto tcp = std::make_unique<QTcpSocket>();
        QVERIFY2(tcp->bind(address, port, QAbstractSocket::DontShareAddress),
                 qPrintable(tcp->errorString()));
        auto udp = std::make_unique<QUdpSocket>();
        QVERIFY2(udp->bind(address, port, QAbstractSocket::DontShareAddress),
                 qPrintable(udp->errorString()));
        ports.insert(port);
        tcpSockets.push_back(std::move(tcp));
        udpSockets.push_back(std::move(udp));
      }
    } catch (const std::exception &error) {
      QFAIL(error.what());
    }
    QCOMPARE(ports.size(), 64);
  }
#endif
  void qtSystemFormattingSurvivesLibmpvStartup() {
    const QByteArray characterLocale(std::setlocale(LC_CTYPE, nullptr));
    const QByteArray timeLocale(std::setlocale(LC_TIME, nullptr));
    const QLocale userLocale;
    const auto formattedNumber = userLocale.toString(1234.5, 'f', 1);
    const auto systemLocale = QLocale::system().name();
    if (qEnvironmentVariableIsSet("WATCHPAIR_TEST_COMMA_LOCALE")) {
      // The fixture must reproduce the real desktop environment, rather than
      // passing under the C-only locale configuration common in CI and WSL.
      QCOMPARE(QByteArray(std::localeconv()->decimal_point), QByteArray(","));
      QCOMPARE(userLocale.decimalPoint(), QStringLiteral(","));
    }

    wp::configureNativeRuntime();
    QCOMPARE(QByteArray(std::setlocale(LC_NUMERIC, nullptr)), QByteArray("C"));
    QCOMPARE(QByteArray(std::setlocale(LC_CTYPE, nullptr)), characterLocale);
    QCOMPARE(QByteArray(std::setlocale(LC_TIME, nullptr)), timeLocale);
    QCOMPARE(QLocale::system().name(), systemLocale);
    QCOMPARE(QLocale().toString(1234.5, 'f', 1), formattedNumber);

    wp::Player player(nullptr, true);
    QVERIFY(player.native());
    QCOMPARE(mpv_set_property_string(player.native(), "speed", "1.25"), 0);
    double speed = 0;
    QCOMPARE(mpv_get_property(player.native(), "speed", MPV_FORMAT_DOUBLE, &speed), 0);
    QCOMPARE(speed, 1.25);
  }
};

int main(int argc, char **argv) {
  QApplication app(argc, argv);
  NativeRuntimeTests tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "native_runtime_tests.moc"
