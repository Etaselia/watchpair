#pragma once
#include "app_services.h"
#include "player_surface.h"
#include "ui_models.h"
#include "video_widget.h"
#include <QComboBox>
#include <QDoubleSpinBox>
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>
#include <QSlider>
#include <QSortFilterProxyModel>
#include <QSplitter>
#include <QStackedWidget>
#include <QTabBar>
#include <QTableView>
#include <QTableWidget>
#include <QWidget>
namespace wp::ui {
class QueueProxy final : public QSortFilterProxyModel {
  Q_OBJECT
public:
  explicit QueueProxy(QObject *parent = nullptr);
  void setContext(const QString &room, qint64 revision) { room_ = room; revision_ = revision; }
  Qt::ItemFlags flags(const QModelIndex &index) const override;
  QStringList mimeTypes() const override;
  QMimeData *mimeData(const QModelIndexList &indexes) const override;
  bool canDropMimeData(const QMimeData *data, Qt::DropAction action, int row, int column,
                       const QModelIndex &parent) const override;
  bool dropMimeData(const QMimeData *data, Qt::DropAction action, int row, int column,
                    const QModelIndex &parent) override;
  Qt::DropActions supportedDropActions() const override { return Qt::MoveAction; }
  Qt::DropActions supportedDragActions() const override { return Qt::MoveAction; }
signals:
  void reorderRequested(QStringList ids, qint64 revision);
public:
  void search(const QString &text) {
#if QT_VERSION >= QT_VERSION_CHECK(6, 10, 0)
    beginFilterChange();
    query_ = text;
    endFilterChange(QSortFilterProxyModel::Direction::Rows);
#else
    query_ = text;
    invalidateFilter();
#endif
  }

protected:
  bool filterAcceptsRow(int row, const QModelIndex &parent) const override;

private:
  bool dropOrder(const QMimeData *data, Qt::DropAction action, int row, int column,
                 const QModelIndex &parent, QStringList *changedOrder) const;
  QString query_, room_;
  qint64 revision_ = -1;
};
class RoomPage final : public QWidget {
  Q_OBJECT
public:
  explicit RoomPage(AppServices &services, QWidget *parent = nullptr);
  void setRoom(const QString &room);
  void refresh();
  void fullscreen(bool enabled);
  PlayerSurface *playerSurface() const { return surface_; }
  void setPlayerDetached(bool detached);
  void showWatched() { queueTabs_->setCurrentIndex(1); }
  VideoWidget *video() const { return video_; }
signals:
  void addRequested(QString room);
  void manageRequested(QString room);
  void fullscreenRequested();
  void popoutRequested();
  void transferRequested(QString transfer);
  void subtitleRequested(QString room);
  void sourceFilesRequested(QString room, QString source);

private:
  void updateQueue();
  void updateTracks();
  void mark(bool watched);
  void reorder(int direction);
  void rewatch();
  void approveEntry(const QJsonObject &entry);
  void clearList();
  void updateQueueActions();
  void trackChoice();
  void seekPlayer(double seconds);
  void skipChapter(int direction);
  bool chapterMetadataReady() const;
  bool trackInventoryReady() const;
  QString selectedEntry() const;
  QStringList selectedEntries() const;
  AppServices &app_;
  QString room_;
  JsonTable queueModel_, historyModel_;
  QueueProxy queueProxy_;
  QSortFilterProxyModel historyProxy_;
  QWidget *header_, *queuePanel_, *playbackControls_, *trackControls_;
  QWidget *playerHeader_, *playerHome_;
  PlayerSurface *surface_;
  QFrame *overlay_;
  QSplitter *split_;
  VideoWidget *video_;
  QTableView *queue_, *history_;
  QTableWidget *members_;
  QTabBar *queueTabs_;
  QStackedWidget *queueStack_;
  QLabel *roomTitle_, *roomSubtitle_, *episodeTitle_, *state_, *time_, *overlayText_;
  QPushButton *join_, *leave_, *play_, *next_, *overlayAction_, *loadHistory_;
  QPushButton *queueUp_, *queueDown_, *queueMark_;
  QAction *queueUnwatched_, *queueWatchAgain_, *queueRename_, *queueRemove_, *queueClear_;
  QLabel *queueHint_;
  QPushButton *previousChapter_, *nextChapter_, *skipBack_, *skipForward_, *popout_, *reattach_;
  QSlider *seek_, *volume_;
  QComboBox *policy_, *rate_, *audio_, *subtitles_, *chapters_;
  QDoubleSpinBox *subtitleDelay_;
  QTimer refresh_;
  bool seeking_ = false, fullscreen_ = false;
  double seekDuration_ = 0;
  int seekGeneration_ = -1, tracksGeneration_ = -1;
  QString tracksEntry_;
  QJsonArray loadedHistory_;
  QString historyQuery_;
  qint64 historyGeneration_ = -1;
  QTimer historySearch_;
  std::function<void()> overlayActionFn_;
  QByteArray trackSignature_;
};
} // namespace wp::ui
