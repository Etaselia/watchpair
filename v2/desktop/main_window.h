#pragma once
#include "room_page.h"
#include "transfer_desk.h"
#include "workspace_pages.h"
#include <QMainWindow>
#include <QStackedWidget>
#include <QSystemTrayIcon>
namespace wp::ui {
class MainWindow final : public QMainWindow {
  Q_OBJECT
public:
  explicit MainWindow(AppServices &app);
  ~MainWindow() override;
  void restoreWindow();
  void openLink(const QString &link);
  void showRoom(const QString &key);
  void showTransfers(const QString &id = {});
  void prepareToQuit();
  RoomPage *roomPage() const { return room_; }
  QStackedWidget *pages() const { return pages_; }
signals:
  void shareRequested(QString path, QString room);

protected:
  void closeEvent(QCloseEvent *event) override;
  bool eventFilter(QObject *object, QEvent *event) override;

private:
  void refreshRooms();
  void enterRoom(bool create, const QString &link = {});
  void manageRoom(const QString &key);
  void addSource(const QString &room = {}, const QString &input = {});
  void prepared(const QJsonObject &source);
  void publish(const QString &transfer);
  QString chooseRoom();
  void preview(const QJsonObject &file);
  void toggleFullscreen();
  void togglePopout();
  void reattachPlayer(bool restore = true);
  void issue(const QString &code, const QString &message);
  AppServices &app_;
  QWidget *sidebar_, *topbar_, *banner_;
  QListWidget *roomList_, *navigation_;
  QStackedWidget *pages_;
  QWidget *welcome_;
  RoomPage *room_;
  TransferDesk *transfers_;
  LibraryPage *library_;
  SettingsPage *settings_;
  DiagnosticsPage *diagnostics_;
  StoragePage *storage_;
  QSystemTrayIcon *tray_ = nullptr;
  QLabel *bannerText_, *connection_, *rates_;
  QTimer timer_;
  QString currentRoom_;
  bool full_ = false;
  QWidget *playerWindow_ = nullptr;
  Qt::WindowStates playerWindowState_;
  bool bannerBeforeFullscreen_ = false;
  bool quitting_ = false;
};
} // namespace wp::ui
