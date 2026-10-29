#pragma once
#include "http_fetch.h"
#include "library_service.h"
#include "local_store.h"
#include <QThreadPool>
#include <QTimer>
#include <map>
#include <memory>
namespace wp {
class TransferEngine;
class DirectDownloads final : public QObject {
  Q_OBJECT
public:
  DirectDownloads(LocalStore &store, LibraryService &library, TransferEngine &transfers,
                  QObject *parent = nullptr);
  ~DirectDownloads() override;
  QString add(const QUrl &url, const QString &label, const QString &sha256 = {}, qint64 size = 0,
              bool automatic = false);
  void restore();
  void resume(const QString &id, bool userAction = true);
  void pause(const QString &id);
  void setDemand(const QString &key, const QString &id, bool wanted);
  void removeDemand(const QString &key);
  void remove(const QString &id);
  void setPinned(const QString &id, bool pinned);
  void reload(const QString &id);
  bool busy(const QString &id) const;
  QJsonArray downloads() const;
  QJsonObject download(const QString &id) const;
signals:
  void changed();
  void ready(QString id, QJsonObject file);
  void failed(QString id, QString message);
  void removed(QString id);

private:
  struct Job {
    QJsonObject row;
    QJsonObject route;
    std::shared_ptr<HttpControl> control;
    qint64 bytesLast = 0, sampledAt = 0;
  };
  void persist(Job &job, const QJsonObject &value);
  void allocate();
  void applyDemand(const QString &id);
  void finished(const QString &id, const HttpResult &result);
  void failure(Job &job, const QString &message);
  LocalStore &store_;
  LibraryService &library_;
  TransferEngine &transfers_;
  QThreadPool pool_;
  QTimer timer_;
  std::map<QString, std::unique_ptr<Job>> jobs_;
  QHash<QString, QString> identifying_;
  std::shared_ptr<HttpBudget> budget_ = std::make_shared<HttpBudget>();
};
} // namespace wp
