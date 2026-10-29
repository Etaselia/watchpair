#include "share_dialog.h"
#include <QDialogButtonBox>
#include <QMessageBox>
#include <QVBoxLayout>
namespace wp::ui {
SourceSelectionDialog::SourceSelectionDialog(AppServices &app, const QString &room, const QString &source,
                                             QWidget *parent)
    : QDialog(parent) {
  setWindowTitle(tr("Choose source episodes"));
  resize(840, 670);
  setMinimumSize(650, 480);
  auto *layout = new QVBoxLayout(this);
  auto *hint =
      new QLabel(tr("Queue choices apply to everyone. Download approval applies only to this device. "
                    "Unselecting the current episode stops it and advances to the next selected episode."));
  hint->setWordWrap(true);
  layout->addWidget(hint);
  auto *files = new FileSelector;
  QList<TorrentFile> manifest;
  QHash<int, int> priorities;
  auto media = std::make_shared<QHash<int, QString>>();
  const auto snapshot = app.rooms.room(room);
  for (auto value : snapshot.value(QStringLiteral("entries")).toArray()) {
    const auto e = value.toObject();
    if (e.value(QStringLiteral("sourceId")).toString() != source)
      continue;
    const int index = e.value(QStringLiteral("fileIndex")).toInt();
    manifest.append(
        {index, e.value(QStringLiteral("path")).toString(), e.value(QStringLiteral("size")).toInteger(), 0});
    priorities.insert(index, e.value(QStringLiteral("enabled")).toBool() ? 4 : 0);
    media->insert(index, e.value(QStringLiteral("mediaId")).toString());
  }
  files->setFiles(manifest, priorities);
  layout->addWidget(files, 1);
  auto *download = new QCheckBox(tr("Approve selected episodes for download on this device"));
  download->setChecked(
      app.media.acquisition(room, source).value(QStringLiteral("effectivePolicy")).toString() !=
      QStringLiteral("Never"));
  layout->addWidget(download);
  auto *error = new QLabel;
  error->setTextFormat(Qt::PlainText);
  error->setWordWrap(true);
  error->setObjectName(QStringLiteral("error"));
  layout->addWidget(error);
  auto *buttons = new QDialogButtonBox(QDialogButtonBox::Cancel);
  auto *apply = buttons->addButton(tr("Apply selection"), QDialogButtonBox::AcceptRole);
  apply->setObjectName(QStringLiteral("primary"));
  auto *reload = buttons->addButton(tr("Use current room revision"), QDialogButtonBox::ResetRole);
  reload->hide();
  layout->addWidget(buttons);
  auto revision = std::make_shared<qint64>(snapshot.value(QStringLiteral("queueRevision")).toInteger());
  auto operation = std::make_shared<QString>();
  QJsonObject sourceInfo;
  for (auto v : snapshot.value(QStringLiteral("sources")).toArray())
    if (v.toObject().value(QStringLiteral("id")).toString() == source)
      sourceInfo = v.toObject();
  if (sourceInfo.value(QStringLiteral("publisherId")) ==
      app.rooms.credential(room).value(QStringLiteral("memberId"))) {
    auto *offering = new QCheckBox(tr("Offer my original files to this room"));
    offering->setChecked(app.sharing.offering(room, source));
    layout->insertWidget(layout->count() - 1, offering);
    connect(offering, &QCheckBox::clicked, this, [&app, room, source, offering](bool enabled) {
      app.perform([&] { app.sharing.setOffering(room, source, enabled); });
      offering->setChecked(app.sharing.offering(room, source));
    });
  }
  auto *remove = buttons->addButton(tr("Remove source from room…"), QDialogButtonBox::DestructiveRole);
  connect(remove, &QPushButton::clicked, this, [this, &app, room, source, revision, operation, error] {
    if (!operation->isEmpty())
      return;
    if (QMessageBox::question(
            this, tr("Remove this room source?"),
            tr("Remove its episode catalog for everyone? Watched history and downloaded files stay. If it is "
               "playing, the room advances to the next selected source."),
            QMessageBox::Cancel | QMessageBox::Yes, QMessageBox::Cancel) != QMessageBox::Yes)
      return;
    try {
      *operation = app.rooms.command(
          room,
          {{QStringLiteral("type"), QStringLiteral("source.remove")}, {QStringLiteral("sourceId"), source}},
          {}, {{QStringLiteral("queueRevision"), *revision}});
      error->setText(tr("Removing the room source…"));
    } catch (const AppError &e) {
      error->setText(e.message());
    }
  });
  connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
  connect(apply, &QPushButton::clicked, this,
          [this, &app, room, source, files, download, error, apply, media, revision, operation] {
            try {
              QStringList selected;
              for (int index : files->model.selected())
                selected.append(media->value(index));
              *operation = app.media.selectSource(room, source, selected, download->isChecked(), *revision);
              files->setEnabled(false);
              download->setEnabled(false);
              apply->setEnabled(false);
              error->setText(tr("Saving the shared selection…"));
            } catch (const AppError &e) {
              error->setText(e.message());
            }
          });
  connect(&app.rooms, &RoomClient::operationComplete, this,
          [this, operation](const QString &, const QString &op) {
            if (op == *operation)
              accept();
          });
  connect(&app.rooms, &RoomClient::error, this,
          [&app, operation, files, download, error, reload](const QString &, const QString &,
                                                            const QString &message, const QString &op) {
            if (operation->isEmpty() || *operation != op)
              return;
            error->setText(message);
            if (app.store.get(QStringLiteral("room-command"), op).value(QStringLiteral("state")).toString() !=
                QStringLiteral("pending")) {
              reload->show();
              files->setEnabled(true);
              download->setEnabled(true);
            }
          });
  connect(reload, &QPushButton::clicked, this, [&app, room, operation, revision, reload, apply, error] {
    *revision = app.rooms.room(room).value(QStringLiteral("queueRevision")).toInteger();
    operation->clear();
    reload->hide();
    apply->setEnabled(true);
    error->clear();
  });
  connect(&app.rooms, &RoomClient::roomRemoved, this, [this, room](const QString &key) {
    if (key == room)
      reject();
  });
}
ShareDialog::ShareDialog(AppServices &app, QJsonObject bundle, QWidget *parent)
    : QDialog(parent), app_(app), bundle_(std::move(bundle)) {
  setWindowTitle(tr("Choose shared episodes"));
  resize(840, 670);
  setMinimumSize(650, 480);
  auto *layout = new QVBoxLayout(this);
  auto *title = new QLabel(bundle_.value(QStringLiteral("label")).toString());
  title->setTextFormat(Qt::PlainText);
  title->setObjectName(QStringLiteral("SectionTitle"));
  layout->addWidget(title);
  auto *hint =
      new QLabel(tr("Select episodes for the room. Your original files stay in place; other members download "
                    "their own verified copies. Included subtitles become available to the room."));
  hint->setWordWrap(true);
  hint->setProperty("muted", true);
  layout->addWidget(hint);
  files_ = new FileSelector;
  const auto existingRoom = app_.rooms.room(bundle_.value(QStringLiteral("room")).toString());
  const auto existingSource = bundle_.value(QStringLiteral("identity")).toString() + QLatin1Char(':') +
                              app_.rooms.credential(bundle_.value(QStringLiteral("room")).toString())
                                  .value(QStringLiteral("memberId"))
                                  .toString();
  QHash<int, bool> existingChoices;
  for (auto v : existingRoom.value(QStringLiteral("entries")).toArray())
    if (v.toObject().value(QStringLiteral("sourceId")).toString() == existingSource)
      existingChoices.insert(v.toObject().value(QStringLiteral("fileIndex")).toInt(),
                             v.toObject().value(QStringLiteral("enabled")).toBool());
  QList<TorrentFile> files;
  QHash<int, int> choices;
  for (auto value : bundle_.value(QStringLiteral("assets")).toArray()) {
    const auto f = value.toObject();
    if (f.value(QStringLiteral("kind")).toString() != QStringLiteral("video"))
      continue;
    const int index = f.value(QStringLiteral("fileIndex")).toInt();
    const auto path = f.value(QStringLiteral("path")).toString();
    files.append({index, path, f.value(QStringLiteral("size")).toInteger(), 0});
    choices.insert(index, existingChoices.contains(index) ? (existingChoices.value(index) ? 4 : 0)
                                                          : (TransferEngine::extra(path) ? 0 : 4));
  }
  files_->setFiles(files, choices);
  layout->addWidget(files_, 1);
  error_ = new QLabel;
  error_->setTextFormat(Qt::PlainText);
  error_->setWordWrap(true);
  error_->setObjectName(QStringLiteral("error"));
  layout->addWidget(error_);
  const auto room = bundle_.value(QStringLiteral("room")).toString();
  revision_ = app_.rooms.room(room).value(QStringLiteral("queueRevision")).toInteger();
  auto *buttons = new QDialogButtonBox(QDialogButtonBox::Cancel);
  apply_ = buttons->addButton(tr("Add selected episodes"), QDialogButtonBox::AcceptRole);
  apply_->setObjectName(QStringLiteral("primary"));
  reload_ = buttons->addButton(tr("Use current room queue"), QDialogButtonBox::ResetRole);
  reload_->hide();
  layout->addWidget(buttons);
  connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
  connect(apply_, &QPushButton::clicked, this, [this, room] {
    try {
      operation_ = app_.sharing.publish(bundle_.value(QStringLiteral("id")).toString(), room,
                                        files_->model.selected(), revision_);
      apply_->setEnabled(false);
      files_->setEnabled(false);
      error_->setText(
          tr("Saving the room selection… You can close this window while the confirmed edit is delivered."));
    } catch (const AppError &e) {
      error_->setText(e.message());
    }
  });
  connect(reload_, &QPushButton::clicked, this, [this, room] {
    revision_ = app_.rooms.room(room).value(QStringLiteral("queueRevision")).toInteger();
    operation_.clear();
    files_->setEnabled(true);
    apply_->setEnabled(files_->model.selectedCount() > 0);
    reload_->hide();
    error_->clear();
  });
  connect(&files_->model, &FileTree::selectionChanged, this, [this] {
    if (operation_.isEmpty())
      apply_->setEnabled(files_->model.selectedCount() > 0);
  });
  connect(&app_.rooms, &RoomClient::operationComplete, this, [this](const QString &, const QString &op) {
    if (op == operation_)
      accept();
  });
  connect(
      &app_.rooms, &RoomClient::error, this,
      [this](const QString &, const QString &, const QString &message, const QString &op) {
        if (!operation_.isEmpty() && op == operation_) {
          error_->setText(message);
          const auto pending =
              app_.store.get(QStringLiteral("room-command"), op).value(QStringLiteral("state")).toString() ==
              QStringLiteral("pending");
          reload_->setVisible(!pending);
          if (!pending)
            files_->setEnabled(true);
        }
      });
  connect(&app_.rooms, &RoomClient::roomRemoved, this, [this, room](const QString &key) {
    if (key == room)
      reject();
  });
}
} // namespace wp::ui
