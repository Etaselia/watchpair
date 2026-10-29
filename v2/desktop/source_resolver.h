#pragma once
#include "http_fetch.h"
#include "local_store.h"
#include <QHash>
#include <QObject>
#include <QSet>
#include <QThreadPool>

namespace wp {
struct ResolvedSource {
  QString operationId, kind, uri, localPath, label;
};
// Resolution never creates a transfer or approves payload download.
class SourceResolver final : public QObject {
  Q_OBJECT
public:
  explicit SourceResolver(LocalStore &store, QObject *parent = nullptr);
  ~SourceResolver() override;
  QString resolve(const QString &input, bool automatic = false);
  void setBudget(std::shared_ptr<HttpBudget> budget) { budget_ = std::move(budget); }
  void cancel(const QString &operationId);
  void networkChanged();
signals:
  void resolved(wp::ResolvedSource source);
  void failed(QString operationId, QString code, QString message);
  void progress(QString operationId, QString message);
  void networkActivity(int requests);

private:
  QString cacheTorrent(const QByteArray &data);
  void fetchTorrent(const QString &operation, const QUrl &url, bool automatic);
  void probeMedia(const QString &operation, const QUrl &url, bool automatic);
  void fetch(const QString &operation, const QUrl &url, bool head, bool automatic);
  LocalStore &store_;
  QThreadPool pool_;
  QHash<QString, std::shared_ptr<HttpControl>> pending_;
  QSet<QString> cancelled_;
  std::shared_ptr<HttpBudget> budget_;
  QJsonObject route_;
};
} // namespace wp
Q_DECLARE_METATYPE(wp::ResolvedSource)
