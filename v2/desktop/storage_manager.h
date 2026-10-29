#pragma once
#include "local_store.h"
#include <QSet>
#include <QThreadPool>
#include <QTimer>
#include <atomic>
#include <memory>
namespace wp {
class AppServices;
class StorageManager final : public QObject {
  Q_OBJECT
public:
  explicit StorageManager(AppServices &app);
  ~StorageManager() override;
  void restore();
  void refresh();
  QJsonArray inventory() const;
  void remove(const QString &key, bool erase, bool onlyEligible = false);
  void move(const QString &kind, const QString &id, const QString &base);
  void retryMove(const QString &key);
  void setPinned(const QString &key, bool pinned);
  void configure(const QJsonObject &policy);
  QJsonArray candidates(const QJsonArray &inventory) const;
signals:
  void previewReady(QJsonArray rows);
  void changed();
  void problem(QString code, QString message);

private:
  void runMove(const QJsonObject &journal);
  void finishMove(const QJsonObject &journal);
  void eraseRetained(const QJsonObject &row);
  void automatic();
  AppServices &app_;
  QThreadPool pool_;
  QTimer timer_;
  bool scanning_ = false, automatic_ = false;
  QSet<QString> moving_;
  std::shared_ptr<std::atomic_bool> stop_ = std::make_shared<std::atomic_bool>(false);
};
} // namespace wp
