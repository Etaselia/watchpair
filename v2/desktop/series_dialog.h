#pragma once
#include "room_client.h"
#include <QDialog>
#include <QTimer>

class QCheckBox;
class QComboBox;
class QDateTimeEdit;
class QLabel;
class QLineEdit;
class QListWidget;
class QPushButton;
class QSpinBox;
class QToolButton;

namespace wp::ui {
class SeriesFollowDialog final : public QDialog {
  Q_OBJECT
public:
  explicit SeriesFollowDialog(RoomClient &rooms, QString room, QWidget *parent = nullptr,
                              QJsonObject replacing = {}, QString anchorEntryId = {});

private:
  void lookup();
  void acceptPreview(const QJsonObject &result);
  void invalidatePreview();
  void updateActions();
  void submit();
  RoomClient &rooms_;
  const QString room_;
  const QJsonObject replacing_;
  const QString anchorEntryId_;
  QJsonObject draft_;
  QLineEdit *input_;
  QComboBox *catalog_, *release_;
  QPushButton *search_, *confirm_;
  QLabel *catalogLabel_, *releaseLabel_, *feedback_, *summary_;
  QWidget *options_;
  QCheckBox *overrideAir_, *overrideNumber_, *limit_;
  QDateTimeEdit *airtime_;
  QSpinBox *catalogEpisode_, *finalEpisode_;
  bool busy_ = false;
};

class SeriesManagerDialog final : public QDialog {
  Q_OBJECT
public:
  explicit SeriesManagerDialog(RoomClient &rooms, QString room, QWidget *parent = nullptr);

private:
  void load();
  void updateRows(const QJsonArray &items);
  QJsonObject selected() const;
  void updateActions();
  void action(const QString &name, QJsonObject body = {}, QJsonObject item = {});
  void openFollow(const QJsonObject &replacing = {});
  void editAirtime();
  void editFinale();
  void linkExisting();
  void showActions();
  RoomClient &rooms_;
  const QString room_;
  QJsonArray items_;
  QListWidget *list_;
  QLabel *feedback_, *details_, *alternative_;
  QPushButton *add_, *refresh_, *check_, *pause_, *approve_, *dismiss_;
  QToolButton *more_;
  QTimer timer_;
  quint64 refreshGeneration_ = 0;
  bool busy_ = false, loading_ = false, enabled_ = false;
};
} // namespace wp::ui
