#pragma once
#include "transfer_desk.h"
namespace wp::ui {
class SourceSelectionDialog final : public QDialog {
public:
  SourceSelectionDialog(AppServices &app, const QString &room, const QString &source,
                        QWidget *parent = nullptr);
};
class ShareDialog final : public QDialog {
  Q_OBJECT
public:
  ShareDialog(AppServices &app, QJsonObject bundle, QWidget *parent = nullptr);

private:
  AppServices &app_;
  QJsonObject bundle_;
  FileSelector *files_;
  QLabel *error_;
  QPushButton *apply_, *reload_;
  QComboBox *connectionMode_;
  QString operation_;
  qint64 revision_ = -1;
};
} // namespace wp::ui
