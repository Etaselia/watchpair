#pragma once
#include "http_fetch.h"
#include "local_store.h"
#include <QFutureWatcher>
#include <QThreadPool>
#include <QUrl>
namespace wp {
class TransferEngine;
namespace delivery {
struct Release {
  QString version, platform, sha256, notes;
  QUrl url;
  qint64 size = 0;
  int protocol = 0;
};
QString platform();
QString bundleRoot();
QString runningRoot();
QString launcher(const QString &root);
QString defaultRoot();
int compareVersions(const QString &left, const QString &right);
Release verifyFeed(const QByteArray &envelope, const QByteArray &publicKey, const QString &currentVersion,
                   bool requireNewer = true);
QJsonObject verifyBundle(const QString &directory, const QString &expectedVersion = {});
void extractArchive(const QString &archive, const QString &freshDirectory);
QJsonObject installBundle(const QString &bundle, const QString &root, const QString &profile);
void activate(const QString &root);
void rollback(const QString &root);
void markHealthy();
void waitForProcess(qint64 pid);
} // namespace delivery
class ReleaseManager final : public QObject {
  Q_OBJECT
public:
  ReleaseManager(LocalStore &store, TransferEngine &transfers, QObject *parent = nullptr);
  ~ReleaseManager() override;
  bool busy() const { return busy_; }
  QString status() const { return status_; }
  QString root() const;
  bool canUpdate() const;
  bool canRollback() const;
  bool available() const { return !release_.version.isEmpty(); }
  qint64 received() const { return control_ ? control_->received.load() : 0; }
  qint64 total() const { return control_ ? control_->total.load() : 0; }
  bool staged() const;
  void install(const QString &root);
  void check(const QUrl &feed);
  void download();
  void cancel();
  void restart(bool rollback = false);
signals:
  void changed();
  void problem(QString code, QString message);
  void restartRequested(QString root, QString action);

private:
  void task(const std::function<QString()> &work, const std::function<void()> &success);
  HttpOptions network(const QUrl &url) const;
  LocalStore &store_;
  TransferEngine &transfers_;
  QThreadPool pool_;
  std::shared_ptr<HttpControl> control_;
  delivery::Release release_;
  QString status_;
  QJsonObject route_;
  bool busy_ = false;
};
} // namespace wp
