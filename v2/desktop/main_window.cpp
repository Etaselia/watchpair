#include "main_window.h"
#include "share_dialog.h"
#include "theme.h"
#include <QAbstractItemView>
#include <QAbstractSlider>
#include <QApplication>
#include <QClipboard>
#include <QCloseEvent>
#include <QCryptographicHash>
#include <QDesktopServices>
#include <QDialogButtonBox>
#include <QFileDialog>
#include <QFileInfo>
#include <QFormLayout>
#include <QInputDialog>
#include <QJsonDocument>
#include <QMenu>
#include <QMessageBox>
#include <QProgressDialog>
#include <QShortcut>
#include <QStatusBar>
#include <QToolButton>
#include <QVBoxLayout>
#include <QWindow>
namespace wp::ui {
namespace {
QLabel *plain(const QString &text, const QString &name = {}) {
  auto *label = new QLabel(text);
  label->setTextFormat(Qt::PlainText);
  if (!name.isEmpty())
    label->setObjectName(name);
  return label;
}
bool editing() {
  auto *focus = QApplication::focusWidget();
  return focus && (qobject_cast<QLineEdit *>(focus) || qobject_cast<QAbstractSpinBox *>(focus) ||
                   qobject_cast<QPlainTextEdit *>(focus) || qobject_cast<QComboBox *>(focus) ||
                   qobject_cast<QAbstractItemView *>(focus) || qobject_cast<QAbstractButton *>(focus) ||
                   qobject_cast<QAbstractSlider *>(focus));
}
} // namespace
MainWindow::MainWindow(AppServices &app) : app_(app) {
  setObjectName(QStringLiteral("WatchPairWindow"));
  setWindowTitle(tr("WatchPair"));
  setMinimumSize(1050, 680);
  resize(1480, 900);
  setWindowIcon(icon(QStringLiteral("room"), QColor(QStringLiteral("#73aaff"))));
  if (QSystemTrayIcon::isSystemTrayAvailable()) {
    tray_ = new QSystemTrayIcon(windowIcon(), this);
    tray_->setToolTip(tr("WatchPair"));
    auto *menu = new QMenu(this);
    menu->addAction(tr("Show WatchPair"), this, &MainWindow::restoreWindow);
    menu->addAction(tr("Play / pause"), this,
                    [this] { app_.perform([this] { app_.playback.togglePause(); }); });
    menu->addAction(tr("Pause / resume all transfers"), this, [this] {
      app_.perform([this] {
        auto settings = app_.transfers.configuration();
        settings.insert(QStringLiteral("offline"), !settings.value(QStringLiteral("offline")).toBool());
        app_.transfers.configure(settings);
      });
    });
    menu->addAction(tr("Leave watch"), this,
                    [this] { app_.perform([this] { app_.playback.leaveWatch(); }); });
    menu->addSeparator();
    menu->addAction(tr("Quit WatchPair"), qApp, &QApplication::quit);
    tray_->setContextMenu(menu);
    tray_->show();
    connect(tray_, &QSystemTrayIcon::activated, this, [this](QSystemTrayIcon::ActivationReason reason) {
      if (reason == QSystemTrayIcon::Trigger || reason == QSystemTrayIcon::DoubleClick) {
        restoreWindow();
      }
    });
    qApp->setQuitOnLastWindowClosed(false);
  }
  auto *central = new QWidget;
  auto *outer = new QHBoxLayout(central);
  outer->setContentsMargins(0, 0, 0, 0);
  outer->setSpacing(0);
  sidebar_ = new QFrame;
  sidebar_->setObjectName(QStringLiteral("Sidebar"));
  sidebar_->setFixedWidth(210);
  auto *side = new QVBoxLayout(sidebar_);
  side->setContentsMargins(14, 20, 14, 14);
  side->setSpacing(10);
  auto *brand = new QHBoxLayout;
  auto *logo = plain(QStringLiteral("W"), QStringLiteral("BrandMark"));
  logo->setFixedSize(36, 36);
  logo->setAlignment(Qt::AlignCenter);
  brand->addWidget(logo);
  brand->addWidget(plain(QStringLiteral("WatchPair"), QStringLiteral("BrandName")), 1);
  side->addLayout(brand);
  side->addSpacing(18);
  auto *roomLabel = plain(tr("YOUR ROOMS"), QStringLiteral("NavCaption"));
  side->addWidget(roomLabel);
  roomList_ = new QListWidget;
  roomList_->setObjectName(QStringLiteral("RoomNavigation"));
  roomList_->setFrameShape(QFrame::NoFrame);
  roomList_->setSpacing(3);
  roomList_->setAccessibleName(tr("Your rooms"));
  side->addWidget(roomList_, 1);
  auto *roomButtons = new QHBoxLayout;
  auto *create = new QPushButton(tr("Create"));
  auto *join = new QPushButton(tr("Join…"));
  roomButtons->addWidget(create);
  roomButtons->addWidget(join);
  side->addLayout(roomButtons);
  side->addSpacing(12);
  navigation_ = new QListWidget;
  navigation_->setObjectName(QStringLiteral("Navigation"));
  navigation_->setFrameShape(QFrame::NoFrame);
  navigation_->setSpacing(3);
  navigation_->setFixedHeight(320);
  navigation_->setAccessibleName(tr("Workspace navigation"));
  const QList<QPair<QString, QString>> nav{
      {tr("Transfers"), QStringLiteral("download")}, {tr("Library"), QStringLiteral("library")},
      {tr("Watched"), QStringLiteral("clock")},      {tr("Storage"), QStringLiteral("folder")},
      {tr("Settings"), QStringLiteral("settings")},  {tr("Diagnostics"), QStringLiteral("activity")}};
  for (const auto &[text, image] : nav)
    new QListWidgetItem(icon(image), text, navigation_);
  side->addWidget(navigation_);
  side->addSpacing(8);
  connection_ = plain(tr("Ready"), QStringLiteral("muted"));
  connection_->setWordWrap(true);
  side->addWidget(connection_);
  side->addWidget(plain(tr("WatchPair v2 · Preview"), QStringLiteral("NavCaption")));
  outer->addWidget(sidebar_);
  auto *main = new QWidget;
  auto *layout = new QVBoxLayout(main);
  layout->setContentsMargins(0, 0, 0, 0);
  layout->setSpacing(0);
  topbar_ = new QWidget;
  topbar_->setObjectName(QStringLiteral("Topbar"));
  auto *top = new QHBoxLayout(topbar_);
  top->setContentsMargins(24, 10, 24, 10);
  top->addWidget(plain(tr("Watch together. Keep your own copy."), QStringLiteral("muted")), 1);
  auto *returnButton = new QPushButton(icon(QStringLiteral("play")), tr("Return to player"));
  auto *add = new QToolButton;
  add->setText(tr("Add media"));
  add->setIcon(icon(QStringLiteral("add")));
  add->setToolButtonStyle(Qt::ToolButtonTextBesideIcon);
  add->setPopupMode(QToolButton::InstantPopup);
  auto *addMenu = new QMenu(add);
  add->setMenu(addMenu);
  addMenu->addAction(tr("Link, magnet or file…"), this, [this] { addSource(currentRoom_); });
  addMenu->addAction(tr("Local file…"), this, [this] {
    const auto path = QFileDialog::getOpenFileName(
        this, tr("Choose media or torrent"), {},
        tr("Media or torrent (*.mkv *.mp4 *.m4v *.webm *.avi *.mov *.ts *.m2ts *.torrent);;All files (*)"));
    if (!path.isEmpty())
      addSource(currentRoom_, path);
  });
  addMenu->addAction(tr("Local folder…"), this, [this] {
    const auto path = QFileDialog::getExistingDirectory(this, tr("Share a local folder"));
    if (!path.isEmpty())
      addSource(currentRoom_, path);
  });
  top->addWidget(returnButton);
  top->addWidget(add);
  layout->addWidget(topbar_);
  banner_ = new QFrame;
  banner_->setObjectName(QStringLiteral("IssueBanner"));
  auto *bannerLayout = new QHBoxLayout(banner_);
  bannerLayout->setContentsMargins(24, 9, 12, 9);
  bannerText_ = plain({});
  bannerText_->setWordWrap(true);
  bannerText_->setTextInteractionFlags(Qt::TextSelectableByMouse);
  auto *details = new QPushButton(tr("Details"));
  auto *dismiss = new QPushButton(QStringLiteral("×"));
  dismiss->setAccessibleName(tr("Dismiss notification"));
  dismiss->setFixedWidth(32);
  bannerLayout->addWidget(bannerText_, 1);
  bannerLayout->addWidget(details);
  bannerLayout->addWidget(dismiss);
  layout->addWidget(banner_);
  banner_->hide();
  connect(dismiss, &QPushButton::clicked, banner_, &QWidget::hide);
  connect(details, &QPushButton::clicked, this, [this] { navigation_->setCurrentRow(5); });
  pages_ = new QStackedWidget;
  layout->addWidget(pages_, 1);
  outer->addWidget(main, 1);
  setCentralWidget(central);
  welcome_ = new QWidget;
  welcome_->setObjectName(QStringLiteral("welcomePage"));
  auto *welcomeLayout = new QVBoxLayout(welcome_);
  welcomeLayout->setContentsMargins(70, 50, 70, 50);
  welcomeLayout->addStretch();
  auto *title = plain(tr("Make room for a good watch."), QStringLiteral("HeroTitle"));
  title->setWordWrap(true);
  welcomeLayout->addWidget(title);
  auto *intro = plain(tr("Create a private room, add your episodes, and press Join watch when you’re ready. "
                         "Everyone keeps their own copy; WatchPair keeps you together."),
                      QStringLiteral("HeroText"));
  intro->setWordWrap(true);
  intro->setMaximumWidth(680);
  welcomeLayout->addWidget(intro);
  welcomeLayout->addSpacing(28);
  auto *cards = new QHBoxLayout;
  for (int i = 0; i < 2; ++i) {
    auto *card = new QFrame;
    card->setObjectName(QStringLiteral("card"));
    auto *box = new QVBoxLayout(card);
    box->setContentsMargins(22, 22, 22, 22);
    box->setSpacing(16);
    box->addWidget(
        plain(i ? tr("Have an invite?") : tr("Your room, your queue"), QStringLiteral("SectionTitle")));
    auto *description =
        plain(i ? tr("Paste an invite or private recovery link. No account is needed.")
                : tr("Persistent rooms, shared playback controls, and a separate watched history."),
              QStringLiteral("muted"));
    description->setWordWrap(true);
    box->addWidget(description, 1);
    auto *button = new QPushButton(i ? tr("Join a room…") : tr("Create a room…"));
    button->setObjectName(i ? QString() : QStringLiteral("primary"));
    connect(button, &QPushButton::clicked, this, [this, i] { enterRoom(!i); });
    box->addWidget(button, 0, Qt::AlignLeft);
    cards->addWidget(card, 1);
  }
  welcomeLayout->addLayout(cards);
  welcomeLayout->addSpacing(25);
  auto *local = new QPushButton(tr("Browse your library or play a local file"));
  local->setFlat(true);
  welcomeLayout->addWidget(local, 0, Qt::AlignLeft);
  connect(local, &QPushButton::clicked, this, [this] { navigation_->setCurrentRow(1); });
  welcomeLayout->addStretch();
  pages_->addWidget(welcome_);
  room_ = new RoomPage(app_);
  pages_->addWidget(room_);
  transfers_ = new TransferDesk(app_);
  pages_->addWidget(transfers_);
  library_ = new LibraryPage(app_);
  pages_->addWidget(library_);
  settings_ = new SettingsPage(app_);
  pages_->addWidget(settings_);
  diagnostics_ = new DiagnosticsPage(app_);
  pages_->addWidget(diagnostics_);
  storage_ = new StoragePage(app_);
  pages_->addWidget(storage_);
  rates_ = plain({});
  statusBar()->addPermanentWidget(rates_);
  statusBar()->setSizeGripEnabled(true);
  connect(create, &QPushButton::clicked, this, [this] { enterRoom(true); });
  connect(join, &QPushButton::clicked, this, [this] { enterRoom(false); });
  connect(returnButton, &QPushButton::clicked, this, [this] {
    if (app_.playback.local()) {
      navigation_->clearSelection();
      pages_->setCurrentWidget(room_);
    } else if (!currentRoom_.isEmpty())
      showRoom(currentRoom_);
    else
      pages_->setCurrentWidget(welcome_);
  });
  connect(roomList_, &QListWidget::itemClicked, this,
          [this](QListWidgetItem *item) { showRoom(item->data(Qt::UserRole).toString()); });
  connect(navigation_, &QListWidget::currentRowChanged, this, [this](int row) {
    if (row < 0)
      return;
    roomList_->clearSelection();
    if (full_)
      toggleFullscreen();
    switch (row) {
    case 0:
      pages_->setCurrentWidget(transfers_);
      break;
    case 1:
      library_->refresh();
      pages_->setCurrentWidget(library_);
      break;
    case 2:
      if (currentRoom_.isEmpty()) {
        const auto key = chooseRoom();
        if (key.isEmpty())
          return;
        showRoom(key);
      } else
        showRoom(currentRoom_);
      room_->showWatched();
      break;
    case 3:
      storage_->refresh();
      pages_->setCurrentWidget(storage_);
      break;
    case 4:
      settings_->refresh();
      pages_->setCurrentWidget(settings_);
      break;
    case 5:
      diagnostics_->refresh();
      pages_->setCurrentWidget(diagnostics_);
      break;
    }
  });
  connect(&app_.rooms, &RoomClient::roomAdded, this, [this](const QString &key) {
    refreshRooms();
    showRoom(key);
  });
  connect(&app_.rooms, &RoomClient::changed, this, [this] { refreshRooms(); });
  connect(&app_.rooms, &RoomClient::connectionChanged, this, [this] { refreshRooms(); });
  connect(&app_.rooms, &RoomClient::roomRemoved, this, [this](const QString &key) {
    if (currentRoom_ == key) {
      currentRoom_.clear();
      if (!app_.playback.local())
        pages_->setCurrentWidget(welcome_);
    }
    refreshRooms();
  });
  connect(room_, &RoomPage::addRequested, this, [this](const QString &room) { addSource(room); });
  connect(room_, &RoomPage::manageRequested, this, &MainWindow::manageRoom);
  connect(room_, &RoomPage::transferRequested, this, &MainWindow::showTransfers);
  connect(room_, &RoomPage::fullscreenRequested, this, &MainWindow::toggleFullscreen);
  connect(room_, &RoomPage::sourceFilesRequested, this, [this](const QString &room, const QString &source) {
    app_.perform([&] {
      auto *dialog = new SourceSelectionDialog(app_, room, source, this);
      dialog->setAttribute(Qt::WA_DeleteOnClose);
      dialog->open();
    });
  });
  connect(room_, &RoomPage::subtitleRequested, this, [this](const QString &room) {
    const auto path = QFileDialog::getOpenFileName(this, tr("Share subtitles with the room"), {},
                                                   tr("Subtitles (*.srt *.ass *.ssa *.vtt)"));
    if (!path.isEmpty()) {
      if (app_.playback.local()) {
        const auto key =
            QStringLiteral("local:") +
            QString::fromLatin1(QCryptographicHash::hash(path.toUtf8(), QCryptographicHash::Sha256).toHex());
        app_.player.addSubtitle(QUrl::fromLocalFile(path), key);
        app_.playback.setTracks(app_.playback.audioChoice(), key, 0);
      } else
        emit shareRequested(path, room);
    }
  });
  connect(transfers_, &TransferDesk::addRequested, this, [this] { addSource(); });
  connect(transfers_, &TransferDesk::publishRequested, this, &MainWindow::publish);
  connect(transfers_, &TransferDesk::previewRequested, this, &MainWindow::preview);
  connect(library_, &LibraryPage::previewRequested, this, &MainWindow::preview);
  connect(library_, &LibraryPage::shareRequested, this, [this](const QString &path) {
    const auto room = chooseRoom();
    if (!room.isEmpty())
      addSource(room, path);
  });
  connect(&app_.media, &RoomMedia::prepared, this, &MainWindow::prepared);
  connect(this, &MainWindow::shareRequested, this, [this](const QString &path, const QString &room) {
    app_.perform([&] {
      const auto generation = app_.rooms.room(room)
                                  .value(QStringLiteral("playback"))
                                  .toObject()
                                  .value(QStringLiteral("generation"))
                                  .toInt();
      const auto operation = app_.sharing.prepare(path, room);
      auto *progress = new QProgressDialog(tr("Preparing verified shared files…"), tr("Cancel"), 0, 0, this);
      progress->setAttribute(Qt::WA_DeleteOnClose);
      progress->setWindowTitle(tr("Prepare local share"));
      progress->setWindowModality(Qt::NonModal);
      progress->setMinimumDuration(0);
      connect(progress, &QProgressDialog::canceled, this,
              [this, operation] { app_.sharing.cancelPreparation(operation); });
      connect(&app_.sharing, &SharingService::progress, progress,
              [progress, operation](const QString &op, const QString &message) {
                if (op == operation)
                  progress->setLabelText(message);
              });
      connect(&app_.sharing, &SharingService::prepared, progress,
              [this, progress, operation, generation, room](const QJsonObject &bundle) {
                if (bundle.value(QStringLiteral("id")).toString() != operation)
                  return;
                progress->close();
                bool videos = false;
                for (auto value : bundle.value(QStringLiteral("assets")).toArray())
                  if (value.toObject().value(QStringLiteral("kind")).toString() == QStringLiteral("video"))
                    videos = true;
                if (videos) {
                  auto *dialog = new ShareDialog(app_, bundle, this);
                  dialog->setAttribute(Qt::WA_DeleteOnClose);
                  dialog->open();
                } else {
                  const auto assets = bundle.value(QStringLiteral("assets")).toArray();
                  if (!assets.isEmpty())
                    app_.perform([&] {
                      app_.sharing.publishSubtitle(
                          operation, room,
                          assets.first().toObject().value(QStringLiteral("fileIndex")).toInt(), generation);
                    });
                }
              });
      connect(&app_.sharing, &SharingService::preparationFinished, progress,
              [progress, operation](const QString &op) {
                if (op == operation)
                  progress->close();
              });
      progress->show();
    });
  });
  connect(&app_, &AppServices::issue, this, &MainWindow::issue);
  connect(transfers_, &TransferDesk::error, this, &MainWindow::issue);
  auto shortcut = [this](const QKeySequence &key, const std::function<void()> &fn) {
    auto *s = new QShortcut(key, this);
    connect(s, &QShortcut::activated, this, fn);
  };
  shortcut(QKeySequence::Open, [this] { addSource(currentRoom_); });
  shortcut(QKeySequence(QStringLiteral("Ctrl+N")), [this] { enterRoom(true); });
  shortcut(QKeySequence(QStringLiteral("Ctrl+L")), [this] { enterRoom(false); });
  shortcut(QKeySequence(Qt::Key_F11), [this] { toggleFullscreen(); });
  shortcut(QKeySequence(Qt::Key_Escape), [this] {
    if (full_)
      toggleFullscreen();
  });
  auto *space = new QShortcut(QKeySequence(Qt::Key_Space), this);
  connect(space, &QShortcut::activated, this, [this] {
    if (pages_->currentWidget() == room_ && !editing())
      app_.perform([this] { app_.playback.togglePause(); });
  });
  auto updateSpace = [this, space] {
    space->setEnabled(pages_->currentWidget() == room_ && !editing());
  };
  connect(qApp, &QApplication::focusChanged, this, [updateSpace](QWidget *, QWidget *) { updateSpace(); });
  connect(pages_, &QStackedWidget::currentChanged, this, [updateSpace] { updateSpace(); });
  updateSpace();
  connect(&timer_, &QTimer::timeout, this, [this] {
    qint64 down = 0, up = 0;
    for (const auto &v : app_.transfers.transfers()) {
      down += v.downRate;
      up += v.upRate;
    }
    rates_->setText(tr("↓ %1/s    ↑ %2/s").arg(bytes(down), bytes(up)));
  });
  timer_.start(1000);
  const auto geometry =
      QByteArray::fromBase64(app_.store.setting(QStringLiteral("windowGeometry")).toString().toLatin1());
  if (!geometry.isEmpty())
    restoreGeometry(geometry);
  refreshRooms();
  const auto last = app_.store.setting(QStringLiteral("lastRoom")).toString();
  for (auto value : app_.rooms.rooms())
    if (value.toObject().value(QStringLiteral("key")).toString() == last) {
      showRoom(last);
      break;
    }
}
void MainWindow::issue(const QString &code, const QString &message) {
  bannerText_->setText(message);
  bannerText_->setToolTip(code);
  banner_->show();
  statusBar()->showMessage(message, 12000);
}
void MainWindow::refreshRooms() {
  const auto rows = app_.rooms.rooms();
  QSet<QString> keys;
  for (auto value : rows) {
    const auto row = value.toObject();
    const auto key = row.value(QStringLiteral("key")).toString();
    keys.insert(key);
    QListWidgetItem *item = nullptr;
    for (int i = 0; i < roomList_->count(); ++i)
      if (roomList_->item(i)->data(Qt::UserRole).toString() == key) {
        item = roomList_->item(i);
        break;
      }
    if (!item) {
      item = new QListWidgetItem(icon(QStringLiteral("room")), {}, roomList_);
      item->setData(Qt::UserRole, key);
    }
    item->setText(row.value(QStringLiteral("name")).toString());
    item->setToolTip(row.value(QStringLiteral("state")).toString());
    item->setForeground(row.value(QStringLiteral("connected")).toBool() ? QColor(QStringLiteral("#dce8f8"))
                                                                        : QColor(QStringLiteral("#8595ad")));
    if (currentRoom_ == key) {
      connection_->setText(row.value(QStringLiteral("state")).toString());
      if (pages_->currentWidget() == room_)
        roomList_->setCurrentItem(item);
    }
  }
  for (int i = roomList_->count() - 1; i >= 0; --i)
    if (!keys.contains(roomList_->item(i)->data(Qt::UserRole).toString()))
      delete roomList_->takeItem(i);
}
void MainWindow::showRoom(const QString &key) {
  if (key.isEmpty())
    return;
  app_.perform([&] {
    app_.rooms.room(key);
    currentRoom_ = key;
    app_.store.setSetting(QStringLiteral("lastRoom"), key);
    navigation_->setCurrentRow(-1);
    room_->setRoom(key);
    pages_->setCurrentWidget(room_);
    refreshRooms();
  });
}
void MainWindow::showTransfers(const QString &id) {
  navigation_->setCurrentRow(0);
  pages_->setCurrentWidget(transfers_);
  if (!id.isEmpty())
    transfers_->showTransfer(id);
}
void MainWindow::restoreWindow() {
  // xdg-shell has a minimize request but no corresponding unminimize request.
  // Remapping the surface is necessary when restoring from a Wayland tray.
  // The protocol does not report minimized state; Qt's flags can already
  // report normal/visible while the compositor still hides this surface.
  if (QGuiApplication::platformName().startsWith(QStringLiteral("wayland"))) {
    hide();
    setWindowState(Qt::WindowNoState);
    // A hidden xdg_toplevel retains its compositor-side minimized state.
    // Recreate that native surface; shared OpenGL contexts remain alive.
    if (windowHandle()) {
      windowHandle()->destroy();
      windowHandle()->setWindowStates(Qt::WindowNoState);
    }
  }
  if (full_)
    showFullScreen();
  else
    showNormal();
  raise();
  activateWindow();
}
void MainWindow::openLink(const QString &link) {
  restoreWindow();
  enterRoom(false, link);
}
void MainWindow::enterRoom(bool create, const QString &link) {
  auto *dialog = new QDialog(this);
  dialog->setAttribute(Qt::WA_DeleteOnClose);
  dialog->setWindowTitle(create ? tr("Create a private room") : tr("Join or recover a room"));
  dialog->setMinimumWidth(530);
  auto *layout = new QVBoxLayout(dialog);
  auto *form = new QFormLayout;
  layout->addLayout(form);
  auto *server = new QLineEdit(app_.store.setting(QStringLiteral("defaultServer")).toString());
  server->setParent(dialog);
  server->setVisible(create);
  server->setObjectName(QStringLiteral("serverAddress"));
  server->setPlaceholderText(QStringLiteral("https://watchpair.example"));
  auto *name = new QLineEdit;
  name->setParent(dialog);
  name->setVisible(create);
  name->setObjectName(QStringLiteral("roomName"));
  name->setPlaceholderText(tr("Friday watch"));
  name->setMaxLength(300);
  auto *invite = new QLineEdit(link);
  invite->setParent(dialog);
  invite->setVisible(!create);
  invite->setObjectName(QStringLiteral("inviteLink"));
  invite->setPlaceholderText(tr("Paste invite or private recovery link"));
  invite->setClearButtonEnabled(true);
  auto *member =
      new QLineEdit(app_.store.setting(QStringLiteral("displayName"), QStringLiteral("You")).toString());
  member->setMaxLength(80);
  member->setObjectName(QStringLiteral("displayName"));
  if (create) {
    form->addRow(tr("Server"), server);
    form->addRow(tr("Room name"), name);
  } else
    form->addRow(tr("Room link"), invite);
  form->addRow(tr("Your display name"), member);
  auto *description = plain(
      create ? tr("Save the private recovery link after creating the room. It restores host control after "
                  "reinstalling.")
             : tr("Recovery links restore host control and replace old host credentials. Keep them private."),
      QStringLiteral("muted"));
  description->setWordWrap(true);
  layout->addWidget(description);
  auto *error = plain({});
  error->setWordWrap(true);
  error->setObjectName(QStringLiteral("error"));
  layout->addWidget(error);
  auto *buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel);
  auto *submit = buttons->button(QDialogButtonBox::Ok);
  submit->setText(create ? tr("Create room") : tr("Join room"));
  submit->setObjectName(QStringLiteral("primary"));
  layout->addWidget(buttons);
  connect(buttons, &QDialogButtonBox::rejected, dialog, &QDialog::reject);
  auto operation = std::make_shared<QString>();
  connect(buttons, &QDialogButtonBox::accepted, dialog, [=, this] {
    try {
      if (member->text().trimmed().isEmpty())
        throw AppError(QStringLiteral("NAME"), tr("Enter a display name."));
      if (operation->isEmpty())
        *operation = create ? app_.rooms.create(server->text(), name->text(), member->text())
                            : app_.rooms.join(invite->text(), member->text());
      else
        app_.rooms.retryEntry(*operation);
      app_.store.setSetting(QStringLiteral("displayName"), member->text().trimmed());
      if (create)
        app_.store.setSetting(QStringLiteral("defaultServer"), server->text().trimmed());
      submit->setEnabled(false);
      error->setText(tr("Connecting securely…"));
      server->setEnabled(false);
      name->setEnabled(false);
      member->setEnabled(false);
      invite->setEnabled(false);
    } catch (const AppError &e) {
      error->setText(e.message());
    }
  });
  connect(&app_.rooms, &RoomClient::entered, dialog, [=, this](const QString &op, const QString &key) {
    if (op == *operation) {
      dialog->accept();
      showRoom(key);
      if (create) {
        auto *wait = new QTimer(this);
        wait->setInterval(100);
        connect(wait, &QTimer::timeout, this, [this, wait, key] {
          if (app_.store.get(QStringLiteral("room-private"), key).isEmpty()) {
            wait->deleteLater();
            return;
          }
          if (app_.rooms.connected(key)) {
            wait->stop();
            wait->deleteLater();
            manageRoom(key);
          }
        });
        wait->start();
      }
    }
  });
  connect(&app_.rooms, &RoomClient::error, dialog,
          [=](const QString &, const QString &, const QString &message, const QString &op) {
            if (!operation->isEmpty() && op == *operation) {
              error->setText(message);
              submit->setEnabled(true);
              submit->setText(QObject::tr("Retry connection"));
            }
          });
  dialog->open();
}
QString MainWindow::chooseRoom() {
  QStringList labels, keys;
  for (auto value : app_.rooms.rooms()) {
    const auto row = value.toObject();
    labels.append(row.value(QStringLiteral("name")).toString() + QStringLiteral("  · ") +
                  row.value(QStringLiteral("key")).toString().left(6));
    keys.append(row.value(QStringLiteral("key")).toString());
  }
  if (keys.isEmpty()) {
    issue(QStringLiteral("ROOM_REQUIRED"),
          tr("Create or join a room first, then add media to its shared queue."));
    return {};
  }
  if (keys.size() == 1)
    return keys.first();
  bool ok = false;
  const auto choice = QInputDialog::getItem(this, tr("Choose room"), tr("Add to this room"), labels,
                                            std::max(0, int(keys.indexOf(currentRoom_))), false, &ok);
  return ok ? keys.value(labels.indexOf(choice)) : QString();
}
void MainWindow::addSource(const QString &room, const QString &input) {
  QString source = input;
  if (source.isEmpty()) {
    QDialog dialog(this);
    dialog.setWindowTitle(tr("Add media"));
    dialog.setMinimumWidth(590);
    auto *layout = new QVBoxLayout(&dialog);
    auto *label = plain(room.isEmpty() ? tr("Add a transfer or open a file locally.")
                                       : tr("Add episodes to the shared room queue."),
                        QStringLiteral("SectionTitle"));
    layout->addWidget(label);
    auto *edit = new QLineEdit;
    edit->setPlaceholderText(tr("Nyaa link, magnet, .torrent, direct URL or local path"));
    edit->setMinimumHeight(36);
    layout->addWidget(edit);
    auto *row = new QHBoxLayout;
    auto *file = new QPushButton(tr("Choose file…"));
    auto *folder = new QPushButton(tr("Choose folder…"));
    row->addWidget(file);
    row->addWidget(folder);
    row->addStretch();
    layout->addLayout(row);
    auto *hint = plain(tr("Torrent metadata loads first. You can choose whole seasons, skip extras, and "
                          "decide whether this device downloads them before any video starts downloading."),
                       QStringLiteral("muted"));
    hint->setWordWrap(true);
    layout->addWidget(hint);
    auto *buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel);
    buttons->button(QDialogButtonBox::Ok)->setText(tr("Continue"));
    buttons->button(QDialogButtonBox::Ok)->setObjectName(QStringLiteral("primary"));
    layout->addWidget(buttons);
    connect(file, &QPushButton::clicked, &dialog, [&] {
      const auto path = QFileDialog::getOpenFileName(&dialog, tr("Choose media or torrent"));
      if (!path.isEmpty())
        edit->setText(path);
    });
    connect(folder, &QPushButton::clicked, &dialog, [&] {
      const auto path = QFileDialog::getExistingDirectory(&dialog, tr("Choose a media folder"));
      if (!path.isEmpty())
        edit->setText(path);
    });
    connect(buttons, &QDialogButtonBox::accepted, &dialog, &QDialog::accept);
    connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
    if (dialog.exec() != QDialog::Accepted)
      return;
    source = edit->text().trimmed();
  }
  if (source.isEmpty())
    return;
  app_.perform([&] {
    app_.media.prepare(source, room);
    statusBar()->showMessage(tr("Inspecting source…"));
  });
}
void MainWindow::prepared(const QJsonObject &source) {
  const auto kind = source.value(QStringLiteral("kind")).toString(),
             room = source.value(QStringLiteral("room")).toString();
  if (kind == QStringLiteral("torrent")) {
    const auto id = source.value(QStringLiteral("transfer")).toString();
    showTransfers(id);
    auto *dialog = new TorrentChooser(app_, id, room, this);
    dialog->setAttribute(Qt::WA_DeleteOnClose);
    dialog->open();
  } else if (kind == QStringLiteral("local")) {
    if (room.isEmpty())
      preview(source.value(QStringLiteral("file")).toObject());
    else
      emit shareRequested(
          source.value(QStringLiteral("file")).toObject().value(QStringLiteral("path")).toString(), room);
  } else if (kind == QStringLiteral("direct")) {
    const auto id = source.value(QStringLiteral("download")).toString();
    if (QMessageBox::question(this, tr("Download this media?"),
                              tr("Download this URL on this device? It will be verified before it can be "
                                 "shared with the room.")) == QMessageBox::Yes)
      app_.perform([&] {
        if (!room.isEmpty())
          app_.media.requestDirectPublication(id, room);
        app_.direct.resume(id);
      });
    showTransfers();
  } else if (kind == QStringLiteral("folder")) {
    const auto target = room.isEmpty() ? chooseRoom() : room;
    if (!target.isEmpty())
      emit shareRequested(source.value(QStringLiteral("path")).toString(), target);
  }
}
void MainWindow::publish(const QString &transfer) {
  const auto room = chooseRoom();
  if (room.isEmpty())
    return;
  auto *dialog = new TorrentChooser(app_, transfer, room, this);
  dialog->setAttribute(Qt::WA_DeleteOnClose);
  dialog->open();
}
void MainWindow::preview(const QJsonObject &file) {
  app_.perform([&] {
    navigation_->setCurrentRow(-1);
    pages_->setCurrentWidget(room_);
    app_.playback.playLocal(file);
    room_->refresh();
  });
}
void MainWindow::toggleFullscreen() {
  if (pages_->currentWidget() != room_)
    return;
  full_ = !full_;
  room_->fullscreen(full_);
  sidebar_->setVisible(!full_);
  topbar_->setVisible(!full_);
  statusBar()->setVisible(!full_);
  if (full_)
    showFullScreen();
  else
    showNormal();
}
void MainWindow::manageRoom(const QString &key) {
  app_.perform([&] {
    const auto snapshot = app_.rooms.room(key), credential = app_.rooms.credential(key);
    const auto self = credential.value(QStringLiteral("memberId")).toString();
    const bool host = snapshot.value(QStringLiteral("hostId")).toString() == self;
    auto *dialog = new QDialog(this);
    dialog->setAttribute(Qt::WA_DeleteOnClose);
    dialog->setWindowTitle(tr("Room options"));
    dialog->setMinimumWidth(600);
    auto *layout = new QVBoxLayout(dialog);
    auto *form = new QFormLayout;
    layout->addLayout(form);
    auto *name = new QLineEdit(snapshot.value(QStringLiteral("name")).toString());
    name->setMaxLength(300);
    form->addRow(tr("Room name"), name);
    auto *rename = new QPushButton(tr("Rename room"));
    form->addRow(rename);
    connect(rename, &QPushButton::clicked, dialog, [this, key, name] {
      app_.perform([&] {
        app_.rooms.command(key, {{QStringLiteral("type"), QStringLiteral("room.rename")},
                                 {QStringLiteral("name"), name->text()}});
      });
    });
    auto *invite = new QLineEdit(app_.rooms.inviteLink(key));
    invite->setReadOnly(true);
    invite->setPlaceholderText(
        tr("This device does not have the current invite. Ask the host for a fresh link."));
    auto *copy = new QPushButton(tr("Copy invite"));
    auto *inviteRow = new QHBoxLayout;
    inviteRow->addWidget(invite, 1);
    inviteRow->addWidget(copy);
    form->addRow(tr("Invite link"), inviteRow);
    connect(copy, &QPushButton::clicked, dialog, [invite] {
      if (!invite->text().isEmpty())
        QApplication::clipboard()->setText(invite->text());
    });
    auto *reconnect = new QPushButton(tr("Reconnect this device"));
    form->addRow(reconnect);
    connect(reconnect, &QPushButton::clicked, dialog,
            [this, key] { app_.perform([&] { app_.rooms.reconnect(key); }); });
    auto *members = new QComboBox;
    for (auto value : snapshot.value(QStringLiteral("members")).toArray()) {
      const auto member = value.toObject();
      if (member.value(QStringLiteral("id")).toString() != self)
        members->addItem(member.value(QStringLiteral("name")).toString(),
                         member.value(QStringLiteral("id")).toString());
    }
    if (host) {
      auto *recovery = new QLineEdit;
      recovery->setReadOnly(true);
      recovery->setEchoMode(QLineEdit::Password);
      recovery->setText(app_.rooms.inviteLink(key, true));
      auto *recoveryCopy = new QPushButton(tr("Copy private recovery link"));
      form->addRow(tr("Recovery · keep private"), recovery);
      form->addRow(recoveryCopy);
      connect(recoveryCopy, &QPushButton::clicked, dialog, [recovery] {
        if (!recovery->text().isEmpty())
          QApplication::clipboard()->setText(recovery->text());
      });
      auto *privacy = plain(tr("Anyone with the invite can join. Anyone with the recovery link can take host "
                               "control. Save recovery somewhere private."),
                            QStringLiteral("muted"));
      privacy->setWordWrap(true);
      form->addRow(privacy);
      auto *rotateInvite = new QPushButton(tr("Revoke old invite and create a new one"));
      form->addRow(rotateInvite);
      auto *rotateRecovery = new QPushButton(tr("Replace private recovery link"));
      form->addRow(rotateRecovery);
      connect(rotateInvite, &QPushButton::clicked, dialog, [this, key] {
        app_.perform([&] {
          app_.rooms.command(key, {{QStringLiteral("type"), QStringLiteral("room.rotate-invite")}});
        });
      });
      connect(rotateRecovery, &QPushButton::clicked, dialog, [this, key] {
        app_.perform([&] {
          app_.rooms.command(key, {{QStringLiteral("type"), QStringLiteral("room.rotate-recovery")}});
        });
      });
      connect(&app_.rooms, &RoomClient::changed, dialog,
              [this, key, invite, recovery](const QString &changed) {
                if (changed == key) {
                  invite->setText(app_.rooms.inviteLink(key));
                  recovery->setText(app_.rooms.inviteLink(key, true));
                }
              });
      form->addRow(tr("Member administration"), members);
      auto *admin = new QHBoxLayout;
      auto *successor = new QPushButton(tr("Designate successor"));
      auto *handoff = new QPushButton(tr("Hand off host"));
      auto *remove = new QPushButton(tr("Remove member"));
      admin->addWidget(successor);
      admin->addWidget(handoff);
      admin->addWidget(remove);
      form->addRow(admin);
      connect(successor, &QPushButton::clicked, dialog, [this, key, members] {
        if (members->currentIndex() >= 0)
          app_.perform([&] {
            app_.rooms.command(key, {{QStringLiteral("type"), QStringLiteral("room.successor")},
                                     {QStringLiteral("memberId"), members->currentData().toString()}});
          });
      });
      connect(handoff, &QPushButton::clicked, dialog, [this, key, members, dialog] {
        if (members->currentIndex() < 0)
          return;
        if (QMessageBox::question(dialog, tr("Hand off host control?"),
                                  tr("Give host administration to %1?").arg(members->currentText())) ==
            QMessageBox::Yes)
          app_.perform([&] {
            app_.rooms.command(key, {{QStringLiteral("type"), QStringLiteral("room.handoff")},
                                     {QStringLiteral("memberId"), members->currentData().toString()}});
            dialog->accept();
          });
      });
      connect(remove, &QPushButton::clicked, dialog, [this, key, members, dialog] {
        if (members->currentIndex() < 0)
          return;
        if (QMessageBox::question(dialog, tr("Remove member?"),
                                  tr("Remove %1 from this room and revoke their saved credentials?")
                                      .arg(members->currentText())) == QMessageBox::Yes)
          app_.perform([&] {
            app_.rooms.command(key, {{QStringLiteral("type"), QStringLiteral("room.remove-member")},
                                     {QStringLiteral("memberId"), members->currentData().toString()}});
            dialog->accept();
          });
      });
      auto *deleteRoom = new QPushButton(tr("Delete this room and its history…"));
      deleteRoom->setObjectName(QStringLiteral("danger"));
      form->addRow(deleteRoom);
      connect(deleteRoom, &QPushButton::clicked, dialog, [this, key, dialog] {
        if (QMessageBox::warning(dialog, tr("Delete this room permanently?"),
                                 tr("The room, membership and watched history will be deleted for everyone. "
                                    "Downloaded files remain on each device."),
                                 QMessageBox::Cancel | QMessageBox::Yes,
                                 QMessageBox::Cancel) == QMessageBox::Yes)
          app_.perform([&] {
            app_.rooms.command(key, {{QStringLiteral("type"), QStringLiteral("room.delete")}});
            dialog->accept();
          });
      });
    } else if (snapshot.value(QStringLiteral("successorId")).toString() == self) {
      auto *claim = new QPushButton(tr("Take over as designated successor"));
      form->addRow(claim);
      connect(claim, &QPushButton::clicked, dialog, [this, key, dialog] {
        app_.perform([&] {
          app_.rooms.command(key, {{QStringLiteral("type"), QStringLiteral("room.claim-host")}});
          dialog->accept();
        });
      });
    }
    auto *forget = new QPushButton(tr("Forget this room on this device…"));
    form->addRow(forget);
    connect(forget, &QPushButton::clicked, dialog, [this, key, dialog] {
      if (QMessageBox::question(dialog, tr("Forget this room?"),
                                tr("Remove its saved credentials from this device? You will need an invite "
                                   "to return. Save your recovery link first if you are host.")) ==
          QMessageBox::Yes)
        app_.perform([&] {
          app_.playback.leaveWatch();
          dialog->accept();
          app_.rooms.forget(key);
        });
    });
    auto *close = new QDialogButtonBox(QDialogButtonBox::Close);
    layout->addWidget(close);
    connect(close, &QDialogButtonBox::rejected, dialog, &QDialog::reject);
    dialog->open();
  });
}
MainWindow::~MainWindow() {
  // Decoder I/O uses the GUI's verified reader. Abort it before freeing the
  // render context, whose destructor waits for the decoder's video chain.
  app_.perform([this] { app_.playback.stop(); });
}
void MainWindow::prepareToQuit() {
  if (quitting_)
    return;
  quitting_ = true;
  timer_.stop();
  if (full_)
    toggleFullscreen();
  app_.perform([this] {
    app_.store.setSetting(QStringLiteral("windowGeometry"), QString::fromLatin1(saveGeometry().toBase64()));
  });
  if (tray_)
    tray_->hide();
  hide();
}
void MainWindow::closeEvent(QCloseEvent *event) {
  if (!quitting_ && tray_ && app_.store.setting(QStringLiteral("closeToTray"), true).toBool()) {
    hide();
    event->ignore();
    return;
  }
  event->accept();
  qApp->quit();
}
} // namespace wp::ui
