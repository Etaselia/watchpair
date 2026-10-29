#pragma once
#include "app_services.h"
#include "ui_models.h"
#include <QCheckBox>
#include <QComboBox>
#include <QDoubleSpinBox>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QPlainTextEdit>
#include <QSortFilterProxyModel>
#include <QSpinBox>
#include <QTableView>
#include <QTableWidget>
#include <QWidget>
namespace wp::ui {
class LibraryPage final : public QWidget {
  Q_OBJECT
public:
  explicit LibraryPage(AppServices &app, QWidget *parent = nullptr);
  void refresh();
signals:
  void previewRequested(QJsonObject file);
  void shareRequested(QString path);

private:
  QJsonObject selected() const;
  AppServices &app_;
  JsonTable model_;
  QSortFilterProxyModel proxy_;
  QTableView *table_;
  QListWidget *roots_;
  QLabel *status_;
  QLineEdit *search_;
};
class SettingsPage final : public QWidget {
  Q_OBJECT
public:
  explicit SettingsPage(AppServices &app, QWidget *parent = nullptr);
  void refresh();

private:
  void save();
  AppServices &app_;
  QLineEdit *root_, *bind_, *proxy_, *server_, *member_;
  QSpinBox *down_, *up_, *reserve_, *slots_, *connections_, *port_, *proxyPort_;
  QCheckBox *offline_, *dht_, *lsd_, *upnp_, *closeToTray_, *startup_;
  QComboBox *audio_;
  QDoubleSpinBox *subtitleScale_;
  QLabel *status_;
};
class DiagnosticsPage final : public QWidget {
  Q_OBJECT
public:
  explicit DiagnosticsPage(AppServices &app, QWidget *parent = nullptr);
  void refresh();
  QByteArray report() const;

private:
  AppServices &app_;
  QPlainTextEdit *text_;
  QTimer timer_;
};
class StoragePage final : public QWidget {
  Q_OBJECT
public:
  explicit StoragePage(AppServices &app, QWidget *parent = nullptr);
  void refresh();

private:
  QJsonArray selected() const;
  void showRows(const QJsonArray &rows);
  void removeRows(const QJsonArray &rows);
  AppServices &app_;
  QTableWidget *table_;
  QLabel *status_;
  QSpinBox *days_, *capacity_;
  QCheckBox *automatic_, *freeReserve_;
  QJsonArray rows_;
};
} // namespace wp::ui
