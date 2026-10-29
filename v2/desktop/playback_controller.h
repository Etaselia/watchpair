#pragma once
#include "player.h"
#include "room_media.h"
#include "verified_stream.h"
#include <QElapsedTimer>
namespace wp {
class PlaybackController final : public QObject {
  Q_OBJECT
public:
  PlaybackController(LocalStore &store, RoomClient &rooms, RoomMedia &media, TransferEngine &transfers,
                     Player &player, QObject *parent = nullptr);
  ~PlaybackController() override;
  void setRoom(const QString &room);
  QString room() const { return room_; }
  QString entryId() const { return entry_; }
  QString reason() const { return reason_; }
  QString title() const { return title_; }
  bool local() const { return local_; }
  bool joined() const;
  bool paused() const;
  bool playRequested() const;
  double position() const;
  double duration() const;
  double rate() const;
  QString audioChoice() const;
  QString subtitleChoice() const;
  double subtitleDelay() const;
  double drift() const { return drift_; }
  void joinWatch();
  void leaveWatch();
  void choose(const QString &entryId);
  void togglePause();
  void seek(double seconds);
  void setRate(double rate);
  void setTracks(const QString &audio, const QString &subtitle, double delay);
  void playLocal(const QJsonObject &file);
  void retry();
  void stop();
  QJsonObject diagnostics() const;
  bool usesPath(const QString &root) const;
  using SubtitleProvider = std::function<QString(const QString &, const QString &)>;
  void setSubtitleProvider(SubtitleProvider provider) { subtitleProvider_ = std::move(provider); }
signals:
  void changed();
  void error(QString code, QString message);

private:
  void enforceExplicitWatch(const QString &room);
  void tick();
  void closeReader();
  void load(const MediaBinding &binding, const QString &entry, int generation, double target);
  QJsonObject self() const;
  void saveLocalResume();
  LocalStore &store_;
  RoomClient &rooms_;
  RoomMedia &media_;
  TransferEngine &transfers_;
  Player &player_;
  QTimer timer_;
  QTimer start_;
  double scheduledStart_ = -1;
  QElapsedTimer clock_;
  std::unique_ptr<VerifiedStream> stream_;
  std::unique_ptr<LocalFileSource> preview_;
  MediaBinding binding_;
  QString room_, watchRoom_, entry_, reason_, title_;
  QSet<QString> leaving_;
  int generation_ = -1, endedGeneration_ = -1;
  qint64 lastSeek_ = -10000, lastResumeSave_ = 0;
  double target_ = 0, localRate_ = 1, drift_ = 0;
  bool seekIssued_ = false, local_ = false, localPaused_ = false;
  QString localAudio_ = QStringLiteral("auto"), localSubtitle_ = QStringLiteral("off");
  double localSubtitleDelay_ = 0;
  SubtitleProvider subtitleProvider_;
};
} // namespace wp
