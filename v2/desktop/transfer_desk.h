#pragma once
#include "app_services.h"
#include "ui_models.h"
#include <QCheckBox>
#include <QComboBox>
#include <QDialog>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QPlainTextEdit>
#include <QProgressBar>
#include <QPushButton>
#include <QSortFilterProxyModel>
#include <QTabWidget>
#include <QTableView>
#include <QTreeView>
#include <QWidget>
namespace wp::ui {
class FileSelector final : public QWidget {
  Q_OBJECT
public:
  explicit FileSelector(QWidget *parent = nullptr);
  FileTree model;
  QTreeView *tree;
  void setFiles(const QList<TorrentFile> &files, const QHash<int, int> &priorities);
  void loading(const QString &text, bool busy = true);

private:
  QLabel *summary_;
  QLabel *wait_;
  QProgressBar *progress_;
};
class TorrentChooser final : public QDialog {
  Q_OBJECT
public:
  TorrentChooser(AppServices &services, QString transfer, QString room, QWidget *parent = nullptr);

private:
  void manifest(bool reload = false);
  void apply();
  void problem(const QString &text);
  AppServices &app_;
  QString transfer_, room_, operation_;
  qint64 queueRevision_ = -1;
  FileSelector *files_;
  QCheckBox *shared_, *download_, *follow_;
  QLabel *error_;
  QPushButton *apply_, *reload_;
  bool initialized_ = false, conflict_ = false;
};
class TransferProxy final : public QSortFilterProxyModel {
public:
  using QSortFilterProxyModel::QSortFilterProxyModel;
  void filter(const QString &state, const QString &text);

protected:
  bool filterAcceptsRow(int row, const QModelIndex &parent) const override;

private:
  QString state_, text_;
};
class TransferDesk final : public QWidget {
  Q_OBJECT
public:
  explicit TransferDesk(AppServices &services, QWidget *parent = nullptr);
  void showTransfer(const QString &id);
signals:
  void addRequested();
  void publishRequested(QString transfer);
  void previewRequested(QJsonObject file);
  void error(QString code, QString message);

private:
  QStringList selected() const;
  void guard(const std::function<void()> &action);
  void refresh();
  void selection();
  void contentScope();
  void contentState();
  QHash<int, int> contentChoices() const;
  void moveOrder(int direction);
  void removeSelected();
  void moveStorage();
  void editLimits();
  void editTrackers();
  void actionSelected(const std::function<void(const QString &)> &action);
  AppServices &app_;
  TransferTable model_;
  TransferProxy proxy_;
  JsonTable peersModel_, trackersModel_, downloadsModel_;
  QTableView *table_, *peers_, *trackers_, *downloads_;
  QTabWidget *transferTabs_, *details_;
  QListWidget *filters_;
  QLineEdit *search_;
  FileSelector *files_;
  QPushButton *applyFiles_;
  QPushButton *reloadContent_;
  QComboBox *scope_;
  QLabel *contentMessage_;
  qint64 contentRevision_ = -1;
  bool contentDirty_ = false;
  QHash<QString, QString> contentOperations_;
  QHash<QString, QString> contentScopes_;
  QLabel *selectionTitle_, *selectionReason_, *stats_;
  QLineEdit *location_, *identity_;
  QPlainTextEdit *activity_;
  QTimer refresh_;
  QString current_;
};
} // namespace wp::ui
