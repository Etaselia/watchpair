#pragma once
#include "local_store.h"
#include <QElapsedTimer>
#include <QHash>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QObject>
#include <QSet>
#include <QTimer>
#include <QWebSocket>
#include <functional>
#include <map>
#include <memory>
namespace wp {
class RoomClient final : public QObject {
  Q_OBJECT
public:
  explicit RoomClient(LocalStore &store, QObject *parent = nullptr);
  ~RoomClient() override;
  void restore();
  void shutdown();
  QString create(const QString &server, const QString &roomName, const QString &memberName);
  QString join(const QString &link, const QString &memberName);
  void retryEntry(const QString &operationId);
  void forget(const QString &key);
  void reconnect(const QString &key);
  QJsonArray rooms() const;
  QJsonObject room(const QString &key) const;
  QJsonObject entry(const QString &key, const QString &entryId) const;
  QJsonObject credential(const QString &key) const;
  bool connected(const QString &key) const;
  bool clockReady(const QString &key) const;
  QString connectionState(const QString &key) const;
  double serverNow(const QString &key) const;
  double timelinePosition(const QString &key) const;
  // Preparation persists supplemental local intent inside the command's
  // outbox transaction. It must not perform network or native-engine actions.
  using Preparation = std::function<void(const QString &operationId)>;
  QString command(const QString &key, const QJsonObject &command, Preparation preparation = {},
                  const QJsonObject &expected = {});
  void sendStatus(const QString &key, const QJsonObject &status);
  void history(const QString &key, const QJsonObject &cursor = {}, const QString &search = {});
  void transferTicket(const QString &key, const QString &peer, quint16 listenPort);
  void refresh(const QString &key);
  using SeriesReply = std::function<void(QJsonObject, QString)>;
  void probeSeriesFollows(const QString &key);
  bool seriesFollowsAvailable(const QString &key) const;
  bool seriesFollowFromEntryAvailable(const QString &key) const;
  bool seriesPendingFollowsAvailable(const QString &key) const;
  bool seriesFallbackEnabled() const { return seriesFallbackEnabled_; }
  void setSeriesFallbackEnabled(bool enabled);
  void loadSeriesFollows(const QString &key, QObject *context, SeriesReply callback);
  void previewSeriesFollow(const QString &key, const QJsonObject &body, QObject *context,
                           SeriesReply callback);
  void createSeriesFollow(const QString &key, const QJsonObject &body, QObject *context,
                          SeriesReply callback);
  void seriesFollowAction(const QString &key, const QString &id, const QJsonObject &body,
                          QObject *context, SeriesReply callback);
  QString inviteLink(const QString &key, bool recovery = false) const;
  static QUrl validateServer(const QString &server);
signals:
  void roomAdded(QString key);
  void roomRemoved(QString key);
  void changed(QString key);
  void queueChanged(QString key);
  void connectionChanged(QString key);
  void entered(QString operationId, QString key);
  void operationComplete(QString key, QString operationId);
  void error(QString key, QString code, QString message, QString operationId);
  void historyLoaded(QString key, QJsonArray items, bool firstPage);
  void ticketReady(QString key, QString peer, QJsonObject ticket);
  void seriesCapabilityChanged(QString key);
  void seriesFollowsChanged(QString key, QJsonObject result);

private:
  struct Connection {
    QJsonObject credential, snapshot;
    std::unique_ptr<QWebSocket> socket;
    QHash<QString, int> entryIndexes;
    quint64 epoch = 0;
    quint64 historyEpoch = 0;
    qint64 retryAt = 0, lastPong = 0, lastCache = 0;
    int attempts = 0;
    double offset = 0, bestRtt = 1e20;
    QList<QPair<double, double>> clockSamples;
    bool online = false, fresh = false, terminal = false, requesting = false, refreshing = false;
    bool seriesAvailable = false, seriesEntryAvailable = false, seriesPendingAvailable = false,
         seriesProbePending = false;
    bool seriesPreferenceSupported = false, seriesAdvertised = false;
    qint64 seriesProbeAfter = 0;
    QString state = QStringLiteral("Connecting…");
  };
  using Reply = std::function<void(QJsonObject, int, QString, QString)>;
  Connection &connection(const QString &key) const;
  void request(const QUrl &url, const QByteArray &token, const QJsonObject *body, Reply callback);
  void seriesRequest(const QString &key, const QString &suffix, const QJsonObject *body, QObject *context,
                     SeriesReply callback);
  void provideSeriesResponse(const QString &key, quint64 epoch, const QJsonObject &event);
  void syncSeriesPreference(Connection &connection);
  void begin(const QString &key);
  void tick();
  void message(const QString &key, quint64 epoch, const QString &text);
  void apply(const QString &key, const QJsonObject &data, bool snapshot);
  void flush(const QString &key);
  void install(const QJsonObject &credential);
  void deleted(const QString &key);
  qint64 now() const;
  LocalStore &store_;
  QNetworkAccessManager network_;
  QTimer timer_;
  QElapsedTimer clock_;
  qint64 epoch_ = 0;
  qint64 commandSequence_ = 0;
  quint64 connectionEpoch_ = 0;
  bool stopping_ = false;
  bool seriesFallbackEnabled_ = true;
  QSet<QString> entering_;
  QHash<QString, QNetworkReply *> seriesMetadataJobs_;
  std::map<QString, std::unique_ptr<Connection>> connections_;
};
} // namespace wp
