#pragma once
#include <QElapsedTimer>
#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QTimer>
#include <QUrl>
#include <mpv/client.h>

namespace wp {
class Player final : public QObject {
  Q_OBJECT
public:
  explicit Player(QObject *parent = nullptr, bool headless = false, bool silent = false);
  ~Player() override;
  mpv_handle *native() const { return mpv_; }
  void open(const QUrl &url, bool startPaused = false);
  void rendererReady();
  void rendererFailed(const QString &message);
  void setPaused(bool paused);
  void seek(double seconds);
  void stop();
  void setRate(double rate);
  void setVolume(double volume);
  void setAudioDevice(const QString &device);
  void setSubtitleScale(double scale);
  void addSubtitle(const QUrl &url, const QString &portableKey);
  bool setTracks(const QString &audio, const QString &subtitle, double delay);
  QJsonArray tracks() const { return tracks_; }
  QJsonArray chapters() const { return chapters_; }
  QJsonObject mediaInfo() const { return mediaInfo_; }
  QJsonArray audioDevices() const;
  bool paused() const { return paused_; }
  bool seeking() const { return seeking_; }
  bool atEnd() const { return atEnd_; }
  double volume() const { return volume_; }
  double cachedSeconds() const { return cachedSeconds_; }
  double position() const;
  double sampledPosition() const { return position_; }
  double duration() const { return duration_; }
  bool loaded() const { return loaded_; }
  bool buffering() const { return buffering_; }
  QString error() const { return error_; }
signals:
  void changed();
  void activity(QString message);
  void ended();

private:
  void poll();
  void command(const QList<QByteArray> &args);
  void readTracks(const QJsonArray &tracks);
  void updatePlaylist();
  mpv_handle *mpv_ = nullptr;
  QTimer timer_;
  QElapsedTimer clock_;
  qint64 positionAt_ = 0;
  double observedRate_ = 1;
  double position_ = 0, duration_ = 0;
  double volume_ = 80, cachedSeconds_ = 0;
  bool loaded_ = false, buffering_ = false;
  bool renderReady_ = false, pendingOpen_ = false;
  bool paused_ = false, seeking_ = false, atEnd_ = false;
  quint64 epoch_ = 100;
  qint64 activePlaylist_ = -1;
  QHash<qint64, quint64> playlistEpochs_;
  QHash<qint64, QString> pendingEndErrors_;
  QJsonArray nativePlaylist_, devices_;
  qint64 pendingLoaded_ = -1;
  QUrl requested_;
  QJsonArray tracks_, chapters_;
  QJsonObject mediaInfo_;
  QHash<QString, QString> external_;
  QString appliedAudio_, appliedSubtitle_;
  double appliedDelay_ = 1e20, appliedRate_ = -1;
  QString error_;
};
} // namespace wp
