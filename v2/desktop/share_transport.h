#pragma once
#include "room_client.h"
#include "transfer_engine.h"
#include <QPointer>
#include <QQueue>
#include <QTcpServer>
#include <QTcpSocket>
#include <QThreadPool>
namespace wp {
class ShareTransport final : public QObject {
  Q_OBJECT
public:
  ShareTransport(LocalStore &store, RoomClient &rooms, TransferEngine &transfers, QObject *parent = nullptr);
  ~ShareTransport() override;
  bool send(const QString &room, const QString &peer, const QJsonObject &message);
  QString mode(const QString &room, const QString &peer) const;
  QJsonObject diagnostics(const QString &room, const QString &peer) const;
  void setActive(int downloads, int uploads);
  quint16 port() const { return listener_.serverPort(); }
signals:
  void received(QString room, QString peer, QJsonObject message);
  void changed();
  void problem(QString room, QString message);

private:
  struct Frame {
    QByteArray bytes;
    bool media = false;
  };
  struct Peer {
    QString room, id, self, ticket;
    QUrl relay;
    QJsonObject endpoint;
    QByteArray key, context;
    QPointer<QTcpSocket> socket, candidate;
    QByteArray input, output, candidateInput;
    QQueue<Frame> queue;
    Frame uploadFrame;
    std::shared_ptr<HttpControl> receive, upload;
    qint64 expires = 0, retry = 0, requested = 0, directRetry = 0;
    qint64 directStarted = 0;
    int directAttempts = 0, relayRequests = 0, simultaneousRoutes = 0, standbyPromotions = 0;
    bool ticketPending = false, authenticated = false, connecting = false, helloRead = false;
    bool outgoing = false;
    bool directFailed = false, relayActive = false;
    QString state;
  };
  void tick();
  void network();
  Peer &peer(const QString &room, const QString &id);
  void ticket(const QString &room, const QString &id, const QJsonObject &ticket);
  void incoming(QTcpSocket *socket);
  void adoptIncoming(Peer &peer, QTcpSocket *socket, const QByteArray &input);
  bool promoteCandidate(Peer &peer);
  void attach(Peer &peer, QTcpSocket *socket, bool outgoing);
  void bytes(Peer &peer);
  void packet(Peer &peer, const QByteArray &bytes, bool direct = false);
  void relay(Peer &peer);
  bool relayAllowed() const;
  bool canRelay(const Peer &peer) const;
  void close(Peer &peer);
  void fail(Peer &peer, const QString &message);
  LocalStore &store_;
  RoomClient &rooms_;
  TransferEngine &transfers_;
  QByteArray privateKey_, publicKey_;
  QTcpServer listener_;
  QTimer timer_, pump_;
  QThreadPool receives_, uploads_;
  std::map<QString, std::unique_ptr<Peer>> peers_;
  QSet<QString> keyPending_;
  QJsonObject config_;
  int downloads_ = 0, uploadsCount_ = 0;
};
} // namespace wp
