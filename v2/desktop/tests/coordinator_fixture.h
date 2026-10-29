#pragma once
#include <QElapsedTimer>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <stdexcept>
namespace wp::test {
class Coordinator {
public:
  ~Coordinator() {
    if (process_.state() != QProcess::NotRunning) {
      process_.kill();
      process_.waitForFinished(3000);
    }
  }
  void start(const QString &database) {
    const auto script =
        QString::fromUtf8(WATCHPAIR_COORDINATOR_DIR) + QStringLiteral("/dist/tests/native-server.js");
    if (!QFileInfo::exists(script))
      throw std::runtime_error("Build the coordinator test fixture first");
    process_.setProcessChannelMode(QProcess::SeparateChannels);
    process_.start(qEnvironmentVariable("WATCHPAIR_NODE", QStringLiteral("node")), {script, database});
    if (!process_.waitForStarted(5000))
      throw std::runtime_error("Cannot start the coordinator fixture");
    QElapsedTimer clock;
    clock.start();
    while (clock.elapsed() < 10000) {
      process_.waitForReadyRead(100);
      while (process_.canReadLine()) {
        const auto row = QJsonDocument::fromJson(process_.readLine()).object();
        if (row.contains(QStringLiteral("port"))) {
          port_ = row.value(QStringLiteral("port")).toInt();
          return;
        }
      }
      if (process_.state() == QProcess::NotRunning)
        break;
    }
    throw std::runtime_error(process_.readAllStandardError().constData());
  }
  QString url() const { return QStringLiteral("http://127.0.0.1:%1").arg(port_); }
  QJsonObject inspect(const QString &room) {
    process_.write(
        QJsonDocument(QJsonObject{{QStringLiteral("inspectRoom"), room}}).toJson(QJsonDocument::Compact) +
        '\n');
    process_.waitForBytesWritten(1000);
    QElapsedTimer clock;
    clock.start();
    while (clock.elapsed() < 3000) {
      process_.waitForReadyRead(100);
      while (process_.canReadLine()) {
        const auto value = QJsonDocument::fromJson(process_.readLine()).object();
        if (value.contains(QStringLiteral("diagnostics")))
          return value.value(QStringLiteral("diagnostics")).toObject();
      }
    }
    return {};
  }
  bool advance(int milliseconds) {
    process_.write(QJsonDocument(QJsonObject{{QStringLiteral("advanceTimeMs"), milliseconds}})
                       .toJson(QJsonDocument::Compact) +
                   '\n');
    process_.waitForBytesWritten(1000);
    QElapsedTimer clock;
    clock.start();
    while (clock.elapsed() < 3000) {
      process_.waitForReadyRead(100);
      while (process_.canReadLine())
        if (QJsonDocument::fromJson(process_.readLine()).object().value(QStringLiteral("advanced")).toBool())
          return true;
    }
    return false;
  }
  bool dropNextAck() {
    process_.write("{\"dropPath\":\"/commands\"}\n");
    process_.waitForBytesWritten(1000);
    QElapsedTimer clock;
    clock.start();
    while (clock.elapsed() < 3000) {
      process_.waitForReadyRead(100);
      while (process_.canReadLine())
        if (QJsonDocument::fromJson(process_.readLine()).object().value(QStringLiteral("armed")).toBool())
          return true;
    }
    return false;
  }

private:
  QProcess process_;
  int port_ = 0;
};
} // namespace wp::test
