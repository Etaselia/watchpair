#pragma once
#include <QPointer>
#include <QTimer>
#include <QWidget>
class QGridLayout;
class QVBoxLayout;
namespace wp::ui {
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
  bool contains(QWidget *widget) const;
  void hideIdleControls();
  QWidget *video_, *controls_;
  QGridLayout *layers_;
  QVBoxLayout *controlLayout_;
  QTimer idle_;
  QPointer<QWidget> openingCombo_;
  QPointF openingPosition_;
  quint64 openingTimestamp_ = 0;
  bool playing_ = false, blocking_ = true;
};
} // namespace wp::ui
