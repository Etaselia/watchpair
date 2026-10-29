#include "workspace_pages.h"
#include "lifecycle.h"
#include "theme.h"
#include <QApplication>
#include <QDateTime>
#include <QDesktopServices>
#include <QDialogButtonBox>
#include <QDoubleSpinBox>
#include <QFileDialog>
#include <QFileInfo>
#include <QFormLayout>
#include <QHBoxLayout>
#include <QHeaderView>
#include <QJsonDocument>
#include <QMessageBox>
#include <QProgressBar>
#include <QPushButton>
#include <QSaveFile>
#include <QScrollArea>
#include <QScrollBar>
#include <QSplitter>
#include <QVBoxLayout>
namespace wp::ui {
namespace {
QLabel *heading(const QString &text, QVBoxLayout *layout) {
  auto *label = new QLabel(text);
  label->setObjectName(QStringLiteral("pageTitle"));
  layout->addWidget(label);
  return label;
}
QWidget *formCard(const QString &title, QVBoxLayout *layout, QFormLayout *&form) {
  auto *card = new QFrame;
  card->setObjectName(QStringLiteral("card"));
  auto *box = new QVBoxLayout(card);
  auto *label = new QLabel(title);
  label->setObjectName(QStringLiteral("sectionTitle"));
  box->addWidget(label);
  form = new QFormLayout;
  form->setFieldGrowthPolicy(QFormLayout::AllNonFixedFieldsGrow);
  form->setSpacing(12);
  box->addLayout(form);
  layout->addWidget(card);
  return card;
}
QSpinBox *number(QFormLayout *form, const QString &label, int maximum, const QString &suffix = {}) {
  auto *spin = new QSpinBox;
  spin->setRange(0, maximum);
  spin->setSuffix(suffix);
  spin->setAccessibleName(label);
  form->addRow(label, spin);
  return spin;
}
} // namespace
LibraryPage::LibraryPage(AppServices &app, QWidget *parent)
    : QWidget(parent), app_(app), model_(JsonKind::Library, this), proxy_(this) {
  setObjectName(QStringLiteral("libraryPage"));
  auto *layout = new QVBoxLayout(this);
  layout->setContentsMargins(24, 22, 24, 18);
  heading(tr("Library"), layout);
  auto *description = new QLabel(tr(
      "Your identified files, ready to reuse in any room. External files stay in their original folders."));
  description->setWordWrap(true);
  description->setObjectName(QStringLiteral("muted"));
  layout->addWidget(description);
  auto *bar = new QHBoxLayout;
  auto *add = new QPushButton(icon(QStringLiteral("add")), tr("Add folder"));
  auto *scan = new QPushButton(tr("Scan selected folder"));
  auto *remove = new QPushButton(tr("Forget folder"));
  auto *cancel = new QPushButton(tr("Cancel scan"));
  search_ = new QLineEdit;
  search_->setPlaceholderText(tr("Search identified files…"));
  search_->setClearButtonEnabled(true);
  bar->addWidget(add);
  bar->addWidget(scan);
  bar->addWidget(remove);
  bar->addWidget(cancel);
  bar->addStretch();
  bar->addWidget(search_, 1);
  layout->addLayout(bar);
  auto *split = new QSplitter;
  roots_ = new QListWidget;
  roots_->setMinimumWidth(190);
  roots_->setMaximumWidth(360);
  roots_->setAccessibleName(tr("Library folders"));
  split->addWidget(roots_);
  table_ = new QTableView;
  proxy_.setSourceModel(&model_);
  proxy_.setSortRole(SortRole);
  proxy_.setFilterKeyColumn(-1);
  proxy_.setFilterCaseSensitivity(Qt::CaseInsensitive);
  table_->setModel(&proxy_);
  table_->setSelectionBehavior(QAbstractItemView::SelectRows);
  table_->setSelectionMode(QAbstractItemView::SingleSelection);
  table_->setAlternatingRowColors(true);
  table_->setSortingEnabled(true);
  table_->setShowGrid(false);
  table_->verticalHeader()->hide();
  table_->verticalHeader()->setDefaultSectionSize(32);
  table_->horizontalHeader()->setSectionResizeMode(0, QHeaderView::Stretch);
  table_->setColumnWidth(1, 260);
  table_->setColumnWidth(2, 110);
  table_->setColumnWidth(3, 130);
  table_->setAccessibleName(tr("Identified media files"));
  split->addWidget(table_);
  split->setStretchFactor(1, 1);
  split->setSizes({220, 900});
  layout->addWidget(split, 1);
  auto *bottom = new QHBoxLayout;
  status_ = new QLabel;
  status_->setObjectName(QStringLiteral("muted"));
  auto *play = new QPushButton(icon(QStringLiteral("play")), tr("Play locally"));
  auto *share = new QPushButton(tr("Share with room…"));
  auto *reveal = new QPushButton(tr("Open containing folder"));
  bottom->addWidget(status_, 1);
  bottom->addWidget(reveal);
  bottom->addWidget(share);
  bottom->addWidget(play);
  layout->addLayout(bottom);
  connect(add, &QPushButton::clicked, this, [this] {
    const auto path = QFileDialog::getExistingDirectory(this, tr("Add a library folder"));
    if (!path.isEmpty())
      app_.perform([&] {
        const auto id = app_.library.addRoot(path);
        app_.library.scan(id);
      });
  });
  connect(scan, &QPushButton::clicked, this, [this] {
    if (auto *item = roots_->currentItem())
      app_.perform([&] { app_.library.scan(item->data(Qt::UserRole).toString()); });
  });
  connect(remove, &QPushButton::clicked, this, [this] {
    if (auto *item = roots_->currentItem())
      app_.perform([&] { app_.library.removeRoot(item->data(Qt::UserRole).toString()); });
  });
  connect(cancel, &QPushButton::clicked, &app_.library, &LibraryService::cancelScan);
  connect(search_, &QLineEdit::textChanged, &proxy_, &QSortFilterProxyModel::setFilterFixedString);
  auto preview = [this] {
    const auto file = selected();
    if (!file.isEmpty())
      emit previewRequested(file);
  };
  connect(play, &QPushButton::clicked, this, preview);
  connect(table_, &QTableView::doubleClicked, this, preview);
  connect(share, &QPushButton::clicked, this, [this] {
    const auto file = selected();
    if (!file.isEmpty())
      emit shareRequested(file.value(QStringLiteral("path")).toString());
  });
  connect(reveal, &QPushButton::clicked, this, [this] {
    const auto file = selected();
    if (!file.isEmpty())
      QDesktopServices::openUrl(
          QUrl::fromLocalFile(QFileInfo(file.value(QStringLiteral("path")).toString()).absolutePath()));
  });
  connect(&app_.library, &LibraryService::changed, this, &LibraryPage::refresh);
  connect(&app_.library, &LibraryService::progress, status_, &QLabel::setText);
  refresh();
}
QJsonObject LibraryPage::selected() const {
  return model_.row(proxy_.mapToSource(table_->currentIndex()).row());
}
void LibraryPage::refresh() {
  const auto selectedId = selected().value(QStringLiteral("id")).toString();
  const auto rootId =
      roots_->currentItem() ? roots_->currentItem()->data(Qt::UserRole).toString() : QString();
  roots_->clear();
  for (auto value : app_.library.roots()) {
    const auto row = value.toObject();
    auto *item =
        new QListWidgetItem(QFileInfo(row.value(QStringLiteral("path")).toString()).fileName(), roots_);
    item->setData(Qt::UserRole, row.value(QStringLiteral("id")).toString());
    item->setToolTip(row.value(QStringLiteral("path")).toString());
    if (item->data(Qt::UserRole).toString() == rootId)
      roots_->setCurrentItem(item);
  }
  if (roots_->currentRow() < 0 && roots_->count())
    roots_->setCurrentRow(0);
  const auto rows = app_.library.files();
  model_.setRows(rows);
  const int index = model_.indexOf(selectedId);
  if (index >= 0)
    table_->setCurrentIndex(proxy_.mapFromSource(model_.index(index, 0)));
  status_->setText(tr("%1 identified files · %2 folders").arg(rows.size()).arg(roots_->count()));
}
SettingsPage::SettingsPage(AppServices &app, QWidget *parent) : QWidget(parent), app_(app) {
  setObjectName(QStringLiteral("settingsPage"));
  auto *outer = new QVBoxLayout(this);
  outer->setContentsMargins(24, 22, 24, 18);
  heading(tr("Settings"), outer);
  auto *scroll = new QScrollArea;
  scroll->setWidgetResizable(true);
  scroll->setFrameShape(QFrame::NoFrame);
  auto *content = new QWidget;
  auto *layout = new QVBoxLayout(content);
  layout->setContentsMargins(0, 0, 12, 0);
  QFormLayout *form;
  formCard(tr("Rooms"), layout, form);
  server_ = new QLineEdit;
  server_->setPlaceholderText(QStringLiteral("https://watchpair.example"));
  member_ = new QLineEdit;
  member_->setMaxLength(80);
  form->addRow(tr("Default server"), server_);
  form->addRow(tr("Display name"), member_);
  formCard(tr("Desktop"), layout, form);
  closeToTray_ = new QCheckBox(tr("Keep WatchPair in the notification area when closing the window"));
  startup_ = new QCheckBox(tr("Start in the background when I sign in"));
  form->addRow(closeToTray_);
  form->addRow(startup_);
  auto *registerLinks = new QPushButton(tr("Register private invite links for this device"));
  form->addRow(registerLinks);
  connect(registerLinks, &QPushButton::clicked, this, [this] {
    app_.perform([this] {
      desktop::registerProtocol();
      status_->setText(tr("Private invite links now open in this copy of WatchPair. Keep this application "
                          "folder in its current location."));
    });
  });
  formCard(tr("Application and updates"), layout, form);
  auto *deliveryStatus = new QLabel(app_.releases.status());
  deliveryStatus->setObjectName(QStringLiteral("UpdateStatus"));
  deliveryStatus->setWordWrap(true);
  form->addRow(deliveryStatus);
  auto *installation =
      new QLabel(tr("Per-user installation: %1")
                     .arg(app_.releases.root().isEmpty() ? delivery::defaultRoot() : app_.releases.root()));
  installation->setWordWrap(true);
  installation->setTextInteractionFlags(Qt::TextSelectableByMouse);
  form->addRow(installation);
  auto *feed = new QLineEdit(app_.store.setting(QStringLiteral("updateFeed")).toString());
  feed->setObjectName(QStringLiteral("UpdateFeed"));
  feed->setPlaceholderText(tr("https://your-server/downloads/stable.json"));
  form->addRow(tr("Signed release feed"), feed);
  auto *deliveryButtons = new QWidget;
  auto *deliveryLayout = new QHBoxLayout(deliveryButtons);
  deliveryLayout->setContentsMargins(0, 0, 0, 0);
  auto *install = new QPushButton(tr("Install this copy"));
  auto *check = new QPushButton(tr("Check for updates"));
  auto *download = new QPushButton(tr("Download update"));
  auto *cancelUpdate = new QPushButton(tr("Cancel download"));
  for (auto *button : {install, check, download, cancelUpdate})
    deliveryLayout->addWidget(button);
  form->addRow(deliveryButtons);
  auto *restart = new QPushButton(tr("Leave watch and restart installed copy"));
  auto *rollback = new QPushButton(tr("Restore previous version…"));
  form->addRow(restart);
  form->addRow(rollback);
  auto *deliveryProgress = new QProgressBar;
  form->addRow(deliveryProgress);
  auto refreshDelivery = [this, deliveryStatus, installation, install, check, download, cancelUpdate, restart,
                          rollback, deliveryProgress] {
    const auto &release = app_.releases;
    deliveryStatus->setText(release.status());
    installation->setText(tr("Per-user installation: %1")
                              .arg(release.root().isEmpty() ? delivery::defaultRoot() : release.root()));
    install->setEnabled(!release.busy());
    check->setEnabled(!release.busy() && release.canUpdate());
    check->setToolTip(release.canUpdate() ? tr("Verify releases using this build’s pinned signing key")
                                          : tr("This development build has no pinned release signing key"));
    download->setEnabled(!release.busy() && release.available() && !release.root().isEmpty());
    cancelUpdate->setEnabled(release.busy() && release.total() > 0);
    restart->setEnabled(!release.busy() && !release.root().isEmpty());
    restart->setText(release.staged() ? tr("Leave watch and apply verified update")
                                      : tr("Leave watch and restart installed copy"));
    rollback->setEnabled(!release.busy() && release.canRollback());
    deliveryProgress->setVisible(release.busy());
    deliveryProgress->setRange(0, release.total() > 0 ? 1000 : 0);
    if (release.total() > 0)
      deliveryProgress->setValue(int(1000 * release.received() / release.total()));
  };
  connect(&app_.releases, &ReleaseManager::changed, this, refreshDelivery);
  auto *deliveryTimer = new QTimer(this);
  connect(deliveryTimer, &QTimer::timeout, this, refreshDelivery);
  deliveryTimer->start(250);
  connect(install, &QPushButton::clicked, this, [this] {
    app_.perform([this] {
      app_.releases.install(app_.releases.root().isEmpty() ? delivery::defaultRoot() : app_.releases.root());
    });
  });
  connect(check, &QPushButton::clicked, this, [this, feed] {
    app_.perform([this, feed] {
      auto url = feed->text().trimmed();
      if (url.isEmpty() && !server_->text().trimmed().isEmpty()) {
        url = server_->text().trimmed();
        if (url.endsWith(QLatin1Char('/')))
          url.chop(1);
        url += QStringLiteral("/downloads/stable.json");
        feed->setText(url);
      }
      app_.store.setSetting(QStringLiteral("updateFeed"), url);
      app_.releases.check(QUrl(url));
    });
  });
  connect(download, &QPushButton::clicked, this,
          [this] { app_.perform([this] { app_.releases.download(); }); });
  connect(cancelUpdate, &QPushButton::clicked, &app_.releases, &ReleaseManager::cancel);
  connect(restart, &QPushButton::clicked, this,
          [this] { app_.perform([this] { app_.releases.restart(); }); });
  connect(rollback, &QPushButton::clicked, this, [this] {
    if (QMessageBox::question(this, tr("Restore the previous version?"),
                              tr("This leaves the watch and restores the application and local profile from "
                                 "just before the update. "
                                 "Newer local state is archived for recovery. Downloaded media and the "
                                 "room’s server history stay in place.")) == QMessageBox::Yes)
      app_.perform([this] { app_.releases.restart(true); });
  });
  refreshDelivery();
  formCard(tr("Transfers and storage"), layout, form);
  auto *rootRow = new QWidget;
  auto *rootLayout = new QHBoxLayout(rootRow);
  rootLayout->setContentsMargins(0, 0, 0, 0);
  root_ = new QLineEdit;
  auto *browse = new QPushButton(tr("Browse…"));
  rootLayout->addWidget(root_, 1);
  rootLayout->addWidget(browse);
  form->addRow(tr("New download folder"), rootRow);
  connect(browse, &QPushButton::clicked, this, [this] {
    const auto path = QFileDialog::getExistingDirectory(this, tr("Choose download folder"), root_->text());
    if (!path.isEmpty())
      root_->setText(path);
  });
  down_ = number(form, tr("Device download cap · 0 unlimited"), 2000000, tr(" KiB/s"));
  up_ = number(form, tr("Device upload cap · 0 unlimited"), 2000000, tr(" KiB/s"));
  slots_ = number(form, tr("Concurrent downloads · all transports"), 100);
  slots_->setMinimum(1);
  reserve_ = number(form, tr("Keep free disk space"), 1048576, tr(" MiB"));
  auto *priority = new QLabel(tr("Playback gets priority within these limits. Your paused transfers and "
                                 "excluded files stay paused or excluded."));
  priority->setWordWrap(true);
  priority->setObjectName(QStringLiteral("muted"));
  form->addRow(priority);
  formCard(tr("Network"), layout, form);
  offline_ = new QCheckBox(tr("Pause all media transfers"));
  form->addRow(tr("Offline transfers"), offline_);
  bind_ = new QLineEdit;
  bind_->setPlaceholderText(tr("Any interface, or an explicit IP address"));
  form->addRow(tr("Bind media transfers"), bind_);
  proxy_ = new QLineEdit;
  proxy_->setPlaceholderText(tr("SOCKS5 host, optional"));
  form->addRow(tr("Media proxy"), proxy_);
  proxyPort_ = number(form, tr("SOCKS5 port"), 65535);
  proxyPort_->setMinimum(1);
  port_ = number(form, tr("Torrent listening port · 0 automatic"), 65535);
  connections_ = number(form, tr("Peer connections"), 10000);
  connections_->setMinimum(1);
  dht_ = new QCheckBox(tr("Distributed peer discovery"));
  lsd_ = new QCheckBox(tr("Local peer discovery"));
  upnp_ = new QCheckBox(tr("Router port mapping"));
  form->addRow(dht_);
  form->addRow(lsd_);
  form->addRow(upnp_);
  auto *privacy = new QLabel(tr("Proxy mode disables direct discovery and incoming torrent connections. The "
                                "room connection uses your normal HTTPS route."));
  privacy->setWordWrap(true);
  privacy->setObjectName(QStringLiteral("muted"));
  form->addRow(privacy);
  formCard(tr("This device’s player"), layout, form);
  audio_ = new QComboBox;
  audio_->addItem(tr("System default"), QStringLiteral("auto"));
  form->addRow(tr("Audio output"), audio_);
  subtitleScale_ = new QDoubleSpinBox;
  subtitleScale_->setRange(.5, 3);
  subtitleScale_->setSingleStep(.1);
  subtitleScale_->setSuffix(tr("×"));
  form->addRow(tr("Subtitle size"), subtitleScale_);
  auto *tracks = new QLabel(tr("Volume and subtitle size are local. Audio language, subtitle track and "
                               "subtitle timing follow the room."));
  tracks->setWordWrap(true);
  tracks->setObjectName(QStringLiteral("muted"));
  form->addRow(tracks);
  layout->addStretch();
  scroll->setWidget(content);
  outer->addWidget(scroll, 1);
  auto *footer = new QHBoxLayout;
  status_ = new QLabel;
  status_->setWordWrap(true);
  auto *saveButton = new QPushButton(tr("Save settings"));
  saveButton->setObjectName(QStringLiteral("primary"));
  footer->addWidget(status_, 1);
  footer->addWidget(saveButton);
  outer->addLayout(footer);
  connect(saveButton, &QPushButton::clicked, this, &SettingsPage::save);
  refresh();
}
void SettingsPage::refresh() {
  const auto c = app_.transfers.configuration();
  root_->setText(
      c.value(QStringLiteral("downloadRoot")).toString(app_.store.profile() + QStringLiteral("/downloads")));
  bind_->setText(c.value(QStringLiteral("bind")).toString());
  proxy_->setText(c.value(QStringLiteral("proxyHost")).toString());
  proxyPort_->setValue(c.value(QStringLiteral("proxyPort")).toInt(1080));
  down_->setValue(c.value(QStringLiteral("downLimit")).toInt() / 1024);
  up_->setValue(c.value(QStringLiteral("upLimit")).toInt() / 1024);
  slots_->setValue(c.value(QStringLiteral("concurrency")).toInt(3));
  reserve_->setValue(c.value(QStringLiteral("reserveMiB")).toInt(1024));
  port_->setValue(c.value(QStringLiteral("port")).toInt());
  connections_->setValue(c.value(QStringLiteral("connections")).toInt(300));
  offline_->setChecked(c.value(QStringLiteral("offline")).toBool());
  dht_->setChecked(c.value(QStringLiteral("dht")).toBool(true));
  lsd_->setChecked(c.value(QStringLiteral("lsd")).toBool(true));
  upnp_->setChecked(c.value(QStringLiteral("upnp")).toBool());
  server_->setText(app_.store.setting(QStringLiteral("defaultServer")).toString());
  member_->setText(app_.store.setting(QStringLiteral("displayName"), QStringLiteral("You")).toString());
  const auto device = app_.store.setting(QStringLiteral("audioDevice"), QStringLiteral("auto")).toString();
  audio_->clear();
  audio_->addItem(tr("System default"), QStringLiteral("auto"));
  for (auto value : app_.player.audioDevices()) {
    const auto row = value.toObject();
    const auto name = row.value(QStringLiteral("name")).toString();
    if (name != QStringLiteral("auto"))
      audio_->addItem(row.value(QStringLiteral("description")).toString(name), name);
  }
  const int index = audio_->findData(device);
  if (index < 0) {
    audio_->addItem(tr("Unavailable output: %1").arg(device), device);
    audio_->setCurrentIndex(audio_->count() - 1);
  } else
    audio_->setCurrentIndex(index);
  subtitleScale_->setValue(app_.store.setting(QStringLiteral("subtitleScale"), 1).toDouble());
  closeToTray_->setChecked(app_.store.setting(QStringLiteral("closeToTray"), true).toBool());
  startup_->setChecked(app_.store.setting(QStringLiteral("startup"), false).toBool());
}
void SettingsPage::save() {
  app_.perform([this] {
    const auto server = server_->text().trimmed();
    if (!server.isEmpty())
      RoomClient::validateServer(server);
    auto c = app_.transfers.configuration();
    c.insert(QStringLiteral("downloadRoot"), root_->text().trimmed());
    c.insert(QStringLiteral("bind"), bind_->text().trimmed());
    c.insert(QStringLiteral("proxyHost"), proxy_->text().trimmed());
    c.insert(QStringLiteral("proxyPort"), proxyPort_->value());
    c.insert(QStringLiteral("downLimit"), down_->value() * 1024);
    c.insert(QStringLiteral("upLimit"), up_->value() * 1024);
    c.insert(QStringLiteral("concurrency"), slots_->value());
    c.insert(QStringLiteral("reserveMiB"), reserve_->value());
    c.insert(QStringLiteral("port"), port_->value());
    c.insert(QStringLiteral("connections"), connections_->value());
    c.insert(QStringLiteral("offline"), offline_->isChecked());
    c.insert(QStringLiteral("dht"), dht_->isChecked());
    c.insert(QStringLiteral("lsd"), lsd_->isChecked());
    c.insert(QStringLiteral("upnp"), upnp_->isChecked());
    app_.transfers.configure(c);
    if (startup_->isChecked() != app_.store.setting(QStringLiteral("startup"), false).toBool())
      desktop::startAtLogin(startup_->isChecked());
    app_.store.setSetting(QStringLiteral("startup"), startup_->isChecked());
    app_.store.setSetting(QStringLiteral("closeToTray"), closeToTray_->isChecked());
    app_.store.setSetting(QStringLiteral("defaultServer"), server);
    app_.store.setSetting(QStringLiteral("displayName"), member_->text().trimmed());
    app_.store.setSetting(QStringLiteral("audioDevice"), audio_->currentData().toString());
    app_.store.setSetting(QStringLiteral("subtitleScale"), subtitleScale_->value());
    app_.player.setAudioDevice(audio_->currentData().toString());
    app_.player.setSubtitleScale(subtitleScale_->value());
    status_->setText(tr("Saved. Existing storage stays in place; move a transfer from its details."));
  });
}
DiagnosticsPage::DiagnosticsPage(AppServices &app, QWidget *parent) : QWidget(parent), app_(app) {
  auto *layout = new QVBoxLayout(this);
  layout->setContentsMargins(24, 22, 24, 18);
  heading(tr("Diagnostics"), layout);
  auto *label = new QLabel(tr("Connection, playback and transfer events. Export removes private room links, "
                              "tokens, source URLs and local file paths."));
  label->setWordWrap(true);
  label->setObjectName(QStringLiteral("muted"));
  layout->addWidget(label);
  text_ = new QPlainTextEdit;
  text_->setReadOnly(true);
  text_->setLineWrapMode(QPlainTextEdit::NoWrap);
  layout->addWidget(text_, 1);
  auto *exportButton = new QPushButton(tr("Export diagnostic report…"));
  layout->addWidget(exportButton, 0, Qt::AlignRight);
  connect(exportButton, &QPushButton::clicked, this, [this] {
    const auto path = QFileDialog::getSaveFileName(
        this, tr("Export diagnostics"), QStringLiteral("watchpair-diagnostics.json"), tr("JSON (*.json)"));
    if (path.isEmpty())
      return;
    app_.perform([&] {
      QSaveFile out(path);
      const auto bytes = report();
      if (!out.open(QIODevice::WriteOnly) || out.write(bytes) != bytes.size() || !out.commit())
        throw AppError(QStringLiteral("EXPORT"), tr("Could not save the report."));
    });
  });
  connect(&timer_, &QTimer::timeout, this, [this] {
    if (isVisible())
      refresh();
  });
  timer_.start(1500);
  refresh();
}
QByteArray DiagnosticsPage::report() const {
  // Only a deliberately small allowlist leaves the profile. Exception text can
  // contain arbitrary paths/URLs, so exported events retain codes and time only.
  QJsonArray events;
  for (auto value : app_.activity()) {
    const auto row = value.toObject();
    events.append(QJsonObject{{QStringLiteral("at"), row.value(QStringLiteral("at"))},
                              {QStringLiteral("code"), row.value(QStringLiteral("code"))}});
  }
  QJsonArray rooms;
  for (auto value : app_.rooms.rooms()) {
    const auto key = value.toObject().value(QStringLiteral("key")).toString();
    const auto p = app_.rooms.room(key).value(QStringLiteral("playback")).toObject();
    rooms.append(QJsonObject{{QStringLiteral("connected"), app_.rooms.connected(key)},
                             {QStringLiteral("paused"), p.value(QStringLiteral("paused"))},
                             {QStringLiteral("generation"), p.value(QStringLiteral("generation"))}});
  }
  QJsonArray transfers;
  for (const auto &v : app_.transfers.transfers())
    transfers.append(QJsonObject{{QStringLiteral("state"), v.state},
                                 {QStringLiteral("wanted"), v.wanted},
                                 {QStringLiteral("verified"), v.verified},
                                 {QStringLiteral("downRate"), v.downRate},
                                 {QStringLiteral("upRate"), v.upRate},
                                 {QStringLiteral("manualPaused"), v.manualPaused}});
  return QJsonDocument(QJsonObject{{QStringLiteral("application"), QStringLiteral("WatchPair v2")},
                                   {QStringLiteral("version"), QCoreApplication::applicationVersion()},
                                   {QStringLiteral("qt"), QString::fromLatin1(qVersion())},
                                   {QStringLiteral("platform"), QGuiApplication::platformName()},
                                   {QStringLiteral("events"), events},
                                   {QStringLiteral("rooms"), rooms},
                                   {QStringLiteral("transfers"), transfers}})
      .toJson();
}
void DiagnosticsPage::refresh() {
  const bool atEnd = text_->verticalScrollBar()->value() >= text_->verticalScrollBar()->maximum() - 3;
  QStringList lines;
  for (auto value : app_.activity()) {
    const auto row = value.toObject();
    lines.append(QDateTime::fromMSecsSinceEpoch(row.value(QStringLiteral("at")).toInteger())
                     .toString(QStringLiteral("HH:mm:ss")) +
                 QStringLiteral("  ") + row.value(QStringLiteral("code")).toString() + QStringLiteral("  ") +
                 row.value(QStringLiteral("message")).toString());
  }
  const auto text = lines.join(QLatin1Char('\n'));
  if (text_->toPlainText() != text) {
    text_->setPlainText(text);
    if (atEnd)
      text_->verticalScrollBar()->setValue(text_->verticalScrollBar()->maximum());
  }
}
StoragePage::StoragePage(AppServices &app, QWidget *parent) : QWidget(parent), app_(app) {
  setObjectName(QStringLiteral("storagePage"));
  auto *layout = new QVBoxLayout(this);
  layout->setContentsMargins(24, 22, 24, 18);
  heading(tr("Storage"), layout);
  auto *description = new QLabel(
      tr("Review owned copies before cleanup. Pinned files, files in use and external originals are kept. "
         "Removing a copy also stops its room from downloading it again automatically."));
  description->setWordWrap(true);
  description->setObjectName(QStringLiteral("muted"));
  layout->addWidget(description);
  auto *bar = new QHBoxLayout;
  auto *refresh = new QPushButton(tr("Refresh")), *preview = new QPushButton(tr("Preview cleanup")),
       *pin = new QPushButton(tr("Toggle pin")), *move = new QPushButton(tr("Move selected…")),
       *remove = new QPushButton(tr("Remove selected…")), *retry = new QPushButton(tr("Retry storage moves"));
  for (auto *button : {refresh, preview, pin, move, remove, retry})
    bar->addWidget(button);
  layout->addLayout(bar);
  table_ = new QTableWidget(0, 5);
  table_->setObjectName(QStringLiteral("StorageTable"));
  table_->setHorizontalHeaderLabels(
      {tr("Copy"), tr("Size"), tr("Last used"), tr("Cleanup decision"), tr("Folder")});
  table_->setSelectionBehavior(QAbstractItemView::SelectRows);
  table_->setSelectionMode(QAbstractItemView::ExtendedSelection);
  table_->setEditTriggers(QAbstractItemView::NoEditTriggers);
  table_->setAlternatingRowColors(true);
  table_->verticalHeader()->hide();
  table_->horizontalHeader()->setSectionResizeMode(0, QHeaderView::Stretch);
  table_->setColumnWidth(1, 100);
  table_->setColumnWidth(2, 130);
  table_->setColumnWidth(3, 255);
  table_->setColumnWidth(4, 150);
  layout->addWidget(table_, 1);
  auto *card = new QFrame;
  card->setObjectName(QStringLiteral("card"));
  auto *policy = new QHBoxLayout(card);
  automatic_ = new QCheckBox(tr("Automatic cleanup"));
  freeReserve_ = new QCheckBox(tr("Protect free-space reserve"));
  days_ = new QSpinBox;
  days_->setRange(0, 3650);
  days_->setSuffix(tr(" days"));
  days_->setSpecialValueText(tr("No age limit"));
  capacity_ = new QSpinBox;
  capacity_->setRange(0, 2000000);
  capacity_->setSuffix(tr(" GiB"));
  capacity_->setSpecialValueText(tr("No capacity limit"));
  auto *save = new QPushButton(tr("Save policy"));
  for (auto *w :
       {static_cast<QWidget *>(automatic_), static_cast<QWidget *>(days_), static_cast<QWidget *>(capacity_),
        static_cast<QWidget *>(freeReserve_), static_cast<QWidget *>(save)})
    policy->addWidget(w);
  layout->addWidget(card);
  status_ = new QLabel;
  status_->setWordWrap(true);
  layout->addWidget(status_);
  const auto settings = app_.store.setting(QStringLiteral("cleanup")).toObject();
  automatic_->setChecked(settings.value(QStringLiteral("enabled")).toBool());
  days_->setValue(settings.value(QStringLiteral("days")).toInt());
  capacity_->setValue(settings.value(QStringLiteral("capacityMiB")).toInt() / 1024);
  freeReserve_->setChecked(settings.value(QStringLiteral("freeReserve")).toBool());
  connect(save, &QPushButton::clicked, this, [this] {
    app_.perform([&] {
      app_.storage.configure({{QStringLiteral("enabled"), automatic_->isChecked()},
                              {QStringLiteral("days"), days_->value()},
                              {QStringLiteral("capacityMiB"), qint64(capacity_->value()) * 1024},
                              {QStringLiteral("freeReserve"), freeReserve_->isChecked()}});
      status_->setText(tr("Policy saved. Only removed copies or episodes watched in every referencing room "
                          "are eligible. Use Preview cleanup to inspect the current result."));
    });
  });
  connect(refresh, &QPushButton::clicked, this, &StoragePage::refresh);
  connect(preview, &QPushButton::clicked, this, [this] {
    const auto candidates = app_.storage.candidates(rows_);
    QSet<QString> keys;
    for (auto v : candidates)
      keys.insert(v.toObject().value(QStringLiteral("key")).toString());
    table_->clearSelection();
    for (int i = 0; i < table_->rowCount(); ++i)
      if (keys.contains(
              table_->item(i, 0)->data(Qt::UserRole).toJsonObject().value(QStringLiteral("key")).toString()))
        for (int c = 0; c < table_->columnCount(); ++c)
          table_->item(i, c)->setSelected(true);
    qint64 total = 0;
    for (auto v : candidates)
      total += v.toObject().value(QStringLiteral("bytes")).toInteger();
    status_->setText(tr("Saved policy selects %1 copies (%2). Review the selected rows, then use Remove "
                        "selected to apply this preview.")
                         .arg(candidates.size())
                         .arg(bytes(total)));
  });
  connect(pin, &QPushButton::clicked, this, [this] {
    for (auto v : selected())
      app_.perform([&] {
        const auto r = v.toObject();
        app_.storage.setPinned(r.value(QStringLiteral("key")).toString(),
                               !r.value(QStringLiteral("pinned")).toBool());
      });
    this->refresh();
  });
  connect(remove, &QPushButton::clicked, this, [this] { removeRows(selected()); });
  connect(move, &QPushButton::clicked, this, [this] {
    const auto rows = selected();
    if (rows.size() != 1) {
      status_->setText(tr("Select one active transfer to move. Pause it and stop playback first."));
      return;
    }
    const auto r = rows.first().toObject();
    if (r.value(QStringLiteral("retained")).toBool())
      return;
    const auto base = QFileDialog::getExistingDirectory(this, tr("Move into a new owned folder"));
    if (!base.isEmpty())
      app_.perform([&] {
        app_.storage.move(r.value(QStringLiteral("kind")).toString(),
                          r.value(QStringLiteral("id")).toString(), base);
      });
  });
  connect(retry, &QPushButton::clicked, this, [this] {
    for (auto v : app_.store.all(QStringLiteral("file-move")))
      app_.perform([&] { app_.storage.retryMove(v.toObject().value(QStringLiteral("id")).toString()); });
  });
  connect(&app_.storage, &StorageManager::previewReady, this, &StoragePage::showRows);
  connect(&app_.storage, &StorageManager::changed, this, [this] {
    if (isVisible())
      this->refresh();
  });
}
void StoragePage::refresh() {
  status_->setText(tr("Inspecting managed storage…"));
  app_.perform([this] { app_.storage.refresh(); });
}
QJsonArray StoragePage::selected() const {
  QJsonArray rows;
  for (const auto &index : table_->selectionModel()->selectedRows())
    rows.append(table_->item(index.row(), 0)->data(Qt::UserRole).toJsonObject());
  return rows;
}
void StoragePage::showRows(const QJsonArray &rows) {
  QSet<QString> selectedKeys;
  for (auto v : selected())
    selectedKeys.insert(v.toObject().value(QStringLiteral("key")).toString());
  rows_ = rows;
  table_->setRowCount(0);
  qint64 total = 0;
  for (auto v : rows) {
    const auto r = v.toObject();
    const int index = table_->rowCount();
    table_->insertRow(index);
    total += r.value(QStringLiteral("bytes")).toInteger();
    const QStringList values{
        r.value(QStringLiteral("label"))
            .toString(r.value(QStringLiteral("name")).toString(r.value(QStringLiteral("id")).toString())),
        bytes(r.value(QStringLiteral("bytes")).toInteger()),
        r.value(QStringLiteral("lastUsed")).toInteger() > 0
            ? age(r.value(QStringLiteral("lastUsed")).toInteger())
            : QStringLiteral("—"),
        r.value(QStringLiteral("reason")).toString(), r.value(QStringLiteral("root")).toString()};
    for (int c = 0; c < values.size(); ++c) {
      auto *item = new QTableWidgetItem(values[c]);
      item->setToolTip(values[c]);
      item->setData(Qt::UserRole, r);
      table_->setItem(index, c, item);
      if (selectedKeys.contains(r.value(QStringLiteral("key")).toString()))
        item->setSelected(true);
    }
  }
  status_->setText(
      tr("%1 copies · %2 in known managed files. Cleanup uses the saved policy; automatic cleanup is %3.")
          .arg(rows.size())
          .arg(bytes(total))
          .arg(app_.store.setting(QStringLiteral("cleanup"))
                       .toObject()
                       .value(QStringLiteral("enabled"))
                       .toBool()
                   ? tr("on")
                   : tr("off")));
}
void StoragePage::removeRows(const QJsonArray &rows) {
  if (rows.isEmpty())
    return;
  qint64 total = 0;
  QStringList names;
  for (auto v : rows) {
    const auto r = v.toObject();
    total += r.value(QStringLiteral("bytes")).toInteger();
    if (names.size() < 8)
      names.append(
          r.value(QStringLiteral("label"))
              .toString(r.value(QStringLiteral("name")).toString(r.value(QStringLiteral("id")).toString())));
  }
  QMessageBox dialog(QMessageBox::Warning, tr("Remove selected copies?"),
                     tr("Remove %1 copies (%2)?\n\n%3\n\nRoom history stays. Owned files can be deleted; "
                        "external originals and files still in use are kept.")
                         .arg(rows.size())
                         .arg(bytes(total), names.join(QLatin1Char('\n'))),
                     QMessageBox::Cancel | QMessageBox::Yes, this);
  auto *erase = new QCheckBox(tr("Delete the known WatchPair-owned files"));
  dialog.setCheckBox(erase);
  dialog.setDefaultButton(QMessageBox::Cancel);
  if (dialog.exec() != QMessageBox::Yes)
    return;
  for (auto v : rows)
    app_.perform([&] {
      app_.storage.remove(v.toObject().value(QStringLiteral("key")).toString(), erase->isChecked());
    });
  refresh();
}
} // namespace wp::ui
