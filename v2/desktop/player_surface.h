#pragma once
#include <QComboBox>
#include <QPointer>
#include <QTimer>
#include <QWidget>
class QGridLayout;
class QListView;
class QVBoxLayout;
namespace wp::ui {
class PlayerComboBox;
// One presentation host follows the existing native renderer between windows.
class PlayerSurface final : public QWidget {
  Q_OBJECT
public:
  explicit PlayerSurface(QWidget *video, QWidget *parent = nullptr);
  ~PlayerSurface() override;
  void setBlockingOverlay(QWidget *overlay);
  void addControls(QWidget *controls);
  void setPlaybackState(bool playing, bool blocking);
  void revealControls();
  bool controlsVisible() const;
  QWidget *video() const { return video_; }
  void dismissComboPopup();
signals:
  void fullscreenRequested();
  void escapeRequested();
  void pauseRequested();
  void seekRequested(double offset);
  void chapterRequested(int direction);
  void volumeRequested(int offset);
protected:
  bool eventFilter(QObject *object, QEvent *event) override;
  void hideEvent(QHideEvent *event) override;
private:
  friend class PlayerComboBox;
  void showComboPopup(PlayerComboBox &combo);
  void selectComboItem(const QModelIndex &index);
  bool contains(QWidget *widget) const;
  bool controlsInUse() const;
  void showControls();
  void hideControls();
  void updatePointer(const QPoint &globalPosition);
  void updateVisibility();
  void refreshPointerLater();
  void hideIdleControls();
  QWidget *video_, *controls_;
  QGridLayout *layers_;
  QVBoxLayout *controlLayout_;
  QTimer idle_;
  QPointer<QWidget> openingCombo_;
  QPointer<QWidget> pressedControl_;
  QPointer<PlayerComboBox> inlineCombo_;
  QListView *inlinePopup_ = nullptr;
  QPointF openingPosition_;
  QPoint pointerPosition_;
  quint64 openingTimestamp_ = 0;
  quint64 controlPressGeneration_ = 0;
  bool playing_ = false, blocking_ = true, pointerInside_ = false, keyboardControls_ = false;
};

class PlayerComboBox final : public QComboBox {
  Q_OBJECT
public:
  explicit PlayerComboBox(PlayerSurface &surface) : surface_(surface) {}
  void showPopup() override;
  void hidePopup() override;
  QAbstractItemView *popupView() const;
private:
  PlayerSurface &surface_;
};
} // namespace wp::ui
