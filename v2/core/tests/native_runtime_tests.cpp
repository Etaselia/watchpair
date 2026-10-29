#include "native_runtime.h"
#include "player.h"
#include <QApplication>
#include <QLocale>
#include <QtTest>
#include <clocale>

class NativeRuntimeTests final : public QObject {
  Q_OBJECT
private slots:
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
