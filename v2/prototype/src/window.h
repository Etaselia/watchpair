#pragma once
#include "torrent_service.h"
#include "verified_stream.h"
#include "video_widget.h"
#include <QLabel>
#include <QMainWindow>
#include <QPlainTextEdit>
#include <QSlider>
#include <QTableWidget>
#include <QTreeWidget>
namespace wp {
class Window final : public QMainWindow {
  Q_OBJECT
public:
  Window(const QString &profile, bool localOnly = false);
  ~Window() override;
  TorrentService &torrent() { return *torrent_; }
  Player &player() { return *player_; }
  VideoWidget &video() { return *video_; }
  void add(const QString &source, const QString &destination);
  void selectVideosAndPlay();

protected:
  void closeEvent(QCloseEvent *event) override;

private:
  void fillManifest();
  void refresh();
  void applySelection();
  void playSelected();
  void log(const QString &message);
  std::unique_ptr<TorrentService> torrent_;
  std::unique_ptr<VerifiedStream> stream_;
  std::unique_ptr<Player> player_;
  VideoWidget *video_;
  QTreeWidget *files_;
  QTableWidget *transfers_;
  QLabel *status_;
  QSlider *seek_;
  QPlainTextEdit *activity_;
  QTimer refresh_;
  int playingFile_ = -1;
  bool playerPaused_ = false;
};
} // namespace wp
