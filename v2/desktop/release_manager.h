#pragma once
#include "http_fetch.h"
#include "local_store.h"
#include <QFutureWatcher>
#include <QThreadPool>
#include <QTimer>
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
QJsonObject installBundle(const QString &bundle, const QString &root, const QString &profile,
                          bool signedUpdate = false);
QJsonObject installationState(const QString &root);
QString automaticUpdateVersion(const QString &root);
QString prepareRestart(const QString &runningBundle, const QString &root, const QString &profile);
void prepareRollback(const QString &root, const QString &profile);
void activate(const QString &root, bool automatic = false);
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
  QJsonObject installation() const;
  bool canUpdate() const;
  bool canRollback() const;
  bool available() const { return !release_.version.isEmpty(); }
  qint64 received() const { return control_ ? control_->received.load() : 0; }
  qint64 total() const { return control_ ? control_->total.load() : 0; }
  bool staged() const;
  QUrl configuredFeed() const;
  bool automaticUpdatesEnabled() const;
  void setAutomaticUpdatesEnabled(bool enabled);
  QString automaticActivationRoot() const;
  void startAutomaticUpdates(std::function<bool()> idle);
  void stopAutomaticUpdates();
  void install(const QString &root);
  void check(const QUrl &feed, bool background = false);
  void download(bool background = false);
  void cancel();
  void restart(bool rollback = false);
signals:
  void changed();
  void problem(QString code, QString message);
  void backgroundProblem(QString message);
  void restartRequested(QString root, QString action);

private:
  void task(const std::function<QString()> &work, const std::function<void()> &success,
            bool background = false);
  void pollAutomaticUpdates();
  QString automaticInstallationRoot() const;
  HttpOptions network(const QUrl &url) const;
  LocalStore &store_;
  TransferEngine &transfers_;
  QThreadPool pool_;
  std::shared_ptr<HttpControl> control_;
  delivery::Release release_;
  QUrl releaseFeed_;
  QTimer automaticTimer_;
  std::function<bool()> idle_;
  QString status_;
  QJsonObject route_;
  bool busy_ = false, backgroundJob_ = false;
};
} // namespace wp
