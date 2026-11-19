#include "series_dialog.h"
#include <QCheckBox>
#include <QComboBox>
#include <QDateTimeEdit>
#include <QDialogButtonBox>
#include <QFormLayout>
#include <QHBoxLayout>
#include <QInputDialog>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QLocale>
#include <QMenu>
#include <QMessageBox>
#include <QPushButton>
#include <QSignalBlocker>
#include <QSpinBox>
#include <QToolButton>
#include <QVBoxLayout>
#include <algorithm>

namespace wp::ui {
namespace {
QLabel *plainLabel(const QString &text = {}, const char *role = nullptr) {
  auto *label = new QLabel(text);
  label->setTextFormat(Qt::PlainText);
  label->setWordWrap(true);
  if (role)
    label->setObjectName(QString::fromLatin1(role));
  return label;
}

QDateTimeEdit *airtimeEdit(const QDateTime &time) {
  auto *edit = new QDateTimeEdit(time);
  edit->setDisplayFormat(QLocale().dateTimeFormat(QLocale::ShortFormat));
  edit->setDateTimeRange(QDateTime::fromMSecsSinceEpoch(0),
                         QDateTime(QDate(2100, 1, 1), QTime(0, 0), Qt::UTC).toLocalTime());
  edit->setCalendarPopup(true);
  edit->setAccessibleName(QObject::tr("Next airtime in local time"));
  return edit;
}

QString localTime(QJsonValue value, const QString &fallback) {
  if (!value.isDouble() || value.toInteger() <= 0)
    return fallback;
  return QLocale().toString(QDateTime::fromMSecsSinceEpoch(value.toInteger()), QLocale::ShortFormat);
}

QString statusLabel(const QJsonObject &item) {
  const auto status = item.value(QStringLiteral("status")).toString();
  if (status == QStringLiteral("paused"))
    return QObject::tr("Paused");
  if (status == QStringLiteral("stopped"))
    return QObject::tr("Stopped");
  if (status == QStringLiteral("finished"))
    return QObject::tr("Finished");
  if (!item.value(QStringLiteral("alternative")).toObject().isEmpty())
    return QObject::tr("Host review");
  if (!item.value(QStringLiteral("error")).toString().isEmpty())
    return QObject::tr("Needs attention");
  if (!item.value(QStringLiteral("expectedAirAt")).isDouble())
    return QObject::tr("Airtime unknown");
  return item.value(QStringLiteral("expectedAirAt")).toInteger() > QDateTime::currentMSecsSinceEpoch()
             ? QObject::tr("Waiting for airtime")
             : QObject::tr("Waiting for release");
}

bool currentHost(RoomClient &rooms, const QString &room) {
  if (!rooms.connected(room))
    return false;
  const auto host = rooms.room(room).value(QStringLiteral("hostId")).toString();
  return !host.isEmpty() && host == rooms.credential(room).value(QStringLiteral("memberId")).toString();
}

void populateChoices(QComboBox *box, const QJsonArray &items, const QString &placeholder, bool shows) {
  const QSignalBlocker blocker(box);
  const auto previous = box->currentData();
  box->clear();
  box->addItem(placeholder);
  for (const auto value : items) {
    const auto row = value.toObject();
    const auto id = row.value(QStringLiteral("id")).toInteger();
    const auto title = row.value(QStringLiteral("title")).toString();
    if (id < 1 || title.isEmpty())
      continue;
    QString label = title;
    QString tooltip = title;
    if (shows) {
      const auto date = QDate::fromString(row.value(QStringLiteral("startDate")).toString(), Qt::ISODate);
      if (date.isValid()) {
        const auto localized = QLocale().toString(date, QLocale::ShortFormat);
        label += QObject::tr(" · %1").arg(localized);
        tooltip += QObject::tr("\nStarted %1").arg(localized);
      }
      tooltip += QObject::tr("\nMyAnimeList entry %1").arg(id);
      const auto day = row.value(QStringLiteral("broadcastDayJapan")).toString();
      const auto time = row.value(QStringLiteral("broadcastTimeJapan")).toString();
      if (!day.isEmpty() && !time.isEmpty())
        tooltip += QObject::tr("\n%1 at %2 Japan time").arg(day, time);
    }
    box->addItem(label, id);
    box->setItemData(box->count() - 1,
                     QStringLiteral("<p>") +
                         tooltip.toHtmlEscaped().replace(QLatin1Char('\n'), QStringLiteral("<br>")) +
                         QStringLiteral("</p>"),
                     Qt::ToolTipRole);
  }
  box->setCurrentIndex(std::max(0, box->findData(previous)));
  box->setVisible(box->count() > 1);
}
} // namespace

SeriesFollowDialog::SeriesFollowDialog(RoomClient &rooms, QString room, QWidget *parent,
                                       QJsonObject replacing, QString anchorEntryId)
    : QDialog(parent), rooms_(rooms), room_(std::move(room)), replacing_(std::move(replacing)),
      anchorEntryId_(std::move(anchorEntryId)) {
  setObjectName(QStringLiteral("SeriesFollowDialog"));
  setWindowTitle(!replacing_.isEmpty() ? tr("Change release rule") : anchorEntryId_.isEmpty()
                         ? tr("Follow a series") : tr("Follow this series"));
  setMinimumWidth(560);
  auto *layout = new QVBoxLayout(this);
  layout->addWidget(plainLabel(windowTitle(), "SectionTitle"));
  if (!anchorEntryId_.isEmpty()) {
    const auto entry = rooms_.entry(room_, anchorEntryId_);
    auto *label = plainLabel(tr("Room episode: %1").arg(entry.value(QStringLiteral("label")).toString()));
    label->setToolTip(QStringLiteral("<p>") + entry.value(QStringLiteral("path")).toString().toHtmlEscaped() +
                      QStringLiteral("</p>"));
    layout->addWidget(label);
    layout->addWidget(plainLabel(tr("Choose a release of this episode. The follow starts with the next one.")));
  } else {
    layout->addWidget(plainLabel(replacing_.isEmpty()
                                     ? tr("Find a season, then choose the Nyaa release you want to follow.")
                                     : tr("Choose a different release of the next episode. It will be added "
                                          "now, and future episodes will use this release rule.")));
  }
  auto *queryRow = new QHBoxLayout;
  input_ = new QLineEdit;
  input_->setObjectName(QStringLiteral("SeriesSearchInput"));
  input_->setPlaceholderText(tr("Anime title, MyAnimeList link or Nyaa release link"));
  input_->setAccessibleName(tr("Anime title or link"));
  input_->setMaxLength(300);
  if (!replacing_.isEmpty())
    input_->setText(replacing_.value(QStringLiteral("title")).toString());
  search_ = new QPushButton(tr("Search"));
  search_->setObjectName(QStringLiteral("SeriesSearch"));
  search_->setAutoDefault(false);
  queryRow->addWidget(input_, 1);
  queryRow->addWidget(search_);
  layout->addLayout(queryRow);
  catalog_ = new QComboBox;
  catalog_->setObjectName(QStringLiteral("SeriesCatalogChoice"));
  catalog_->setAccessibleName(tr("MyAnimeList season"));
  release_ = new QComboBox;
  release_->setObjectName(QStringLiteral("SeriesReleaseChoice"));
  release_->setAccessibleName(tr("Starting Nyaa release"));
  catalogLabel_ = plainLabel(tr("MyAnimeList season"));
  releaseLabel_ = plainLabel(tr("Nyaa release"));
  catalogLabel_->setBuddy(catalog_);
  releaseLabel_->setBuddy(release_);
  auto *choices = new QFormLayout;
  choices->addRow(catalogLabel_, catalog_);
  choices->addRow(releaseLabel_, release_);
  layout->addLayout(choices);
  for (auto *box : {catalog_, release_}) {
    box->setSizeAdjustPolicy(QComboBox::AdjustToMinimumContentsLengthWithIcon);
    box->setMinimumContentsLength(16);
    box->hide();
  }
  feedback_ = plainLabel();
  feedback_->setObjectName(QStringLiteral("SeriesFeedback"));
  feedback_->setProperty("muted", true);
  layout->addWidget(feedback_);
  summary_ = plainLabel();
  summary_->setObjectName(QStringLiteral("SeriesPreview"));
  layout->addWidget(summary_);

  options_ = new QWidget;
  auto *form = new QFormLayout(options_);
  form->setContentsMargins(0, 0, 0, 0);
  overrideAir_ = new QCheckBox(tr("Set the next airtime manually"));
  airtime_ = airtimeEdit(QDateTime::currentDateTime());
  overrideNumber_ = new QCheckBox(tr("Release numbering differs from MyAnimeList"));
  catalogEpisode_ = new QSpinBox;
  catalogEpisode_->setRange(0, 99999);
  catalogEpisode_->setSpecialValueText(tr("Choose episode"));
  catalogEpisode_->setAccessibleName(tr("Starting episode number in MyAnimeList"));
  limit_ = new QCheckBox(tr("Set a final release episode"));
  finalEpisode_ = new QSpinBox;
  finalEpisode_->setRange(1, 99999);
  finalEpisode_->setAccessibleName(tr("Final episode number in the release"));
  form->addRow(overrideAir_, airtime_);
  form->addRow(overrideNumber_, catalogEpisode_);
  form->addRow(limit_, finalEpisode_);
  options_->hide();
  layout->addWidget(options_);
  auto *buttons = new QDialogButtonBox(QDialogButtonBox::Cancel);
  confirm_ = buttons->addButton(replacing_.isEmpty() ? tr("Follow series") : tr("Change release rule"),
                                QDialogButtonBox::AcceptRole);
  confirm_->setObjectName(QStringLiteral("primary"));
  confirm_->setAutoDefault(false);
  layout->addWidget(buttons);
  connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
  connect(confirm_, &QPushButton::clicked, this, &SeriesFollowDialog::submit);
  connect(search_, &QPushButton::clicked, this, &SeriesFollowDialog::lookup);
  connect(input_, &QLineEdit::returnPressed, this, &SeriesFollowDialog::lookup);
  connect(input_, &QLineEdit::textEdited, this, [this] {
    catalog_->clear();
    release_->clear();
    catalog_->hide();
    release_->hide();
    feedback_->clear();
    invalidatePreview();
    updateActions();
  });
  connect(catalog_, &QComboBox::activated, this, [this](int index) {
    release_->clear();
    release_->hide();
    invalidatePreview();
    if (index > 0)
      lookup();
  });
  connect(release_, &QComboBox::activated, this, [this](int index) {
    invalidatePreview();
    if (index > 0)
      lookup();
  });
  connect(overrideAir_, &QCheckBox::toggled, airtime_, &QDateTimeEdit::setEnabled);
  connect(overrideNumber_, &QCheckBox::toggled, this, [this](bool checked) {
    catalogEpisode_->setEnabled(checked);
    feedback_->setText(checked ? tr("Enter the number MyAnimeList uses for the starting episode.")
                               : QString());
    updateActions();
  });
  connect(catalogEpisode_, &QSpinBox::valueChanged, this, &SeriesFollowDialog::updateActions);
  connect(limit_, &QCheckBox::toggled, finalEpisode_, &QSpinBox::setEnabled);
  connect(&rooms_, &RoomClient::connectionChanged, this, [this](const QString &key) {
    if (key == room_)
      updateActions();
  });
  updateActions();
  input_->setFocus();
  if (!anchorEntryId_.isEmpty())
    QTimer::singleShot(0, this, &SeriesFollowDialog::lookup);
}

void SeriesFollowDialog::invalidatePreview() {
  draft_ = {};
  summary_->clear();
  options_->hide();
  updateActions();
}

void SeriesFollowDialog::updateActions() {
  const bool connected = rooms_.connected(room_);
  input_->setEnabled(!busy_);
  catalog_->setEnabled(!busy_);
  release_->setEnabled(!busy_);
  options_->setEnabled(!busy_);
  catalogLabel_->setVisible(!catalog_->isHidden());
  releaseLabel_->setVisible(!release_->isHidden());
  feedback_->setVisible(!feedback_->text().isEmpty());
  summary_->setVisible(!summary_->text().isEmpty());
  search_->setEnabled(!busy_ && connected && (!input_->text().trimmed().isEmpty() || !anchorEntryId_.isEmpty()));
  const bool numbered = !overrideNumber_->isChecked() || catalogEpisode_->value() > 0;
  confirm_->setEnabled(!busy_ && connected && !draft_.isEmpty() && numbered);
}

void SeriesFollowDialog::lookup() {
  if (!search_->isEnabled())
    return;
  invalidatePreview();
  QJsonObject body{{QStringLiteral("input"), input_->text().trimmed()}};
  if (!anchorEntryId_.isEmpty())
    body.insert(QStringLiteral("entryId"), anchorEntryId_);
  auto malId = catalog_->currentData().toLongLong();
  if (!malId && !replacing_.isEmpty())
    malId = replacing_.value(QStringLiteral("malId")).toInteger();
  if (malId > 0)
    body.insert(QStringLiteral("malId"), malId);
  const auto listingId = release_->currentData().toLongLong();
  if (listingId > 0)
    body.insert(QStringLiteral("listingId"), listingId);
  feedback_->setText(tr("Looking up releases…"));
  busy_ = true;
  updateActions();
  rooms_.previewSeriesFollow(room_, body, this, [this](const QJsonObject &result, const QString &error) {
    busy_ = false;
    if (error.isEmpty())
      acceptPreview(result);
    else
      feedback_->setText(error);
    updateActions();
  });
}

void SeriesFollowDialog::acceptPreview(const QJsonObject &result) {
  populateChoices(catalog_, result.value(QStringLiteral("catalog")).toArray(), tr("Choose a season"), true);
  populateChoices(release_, result.value(QStringLiteral("releases")).toArray(),
                  tr("Choose a starting release"), false);
  const auto draft = result.value(QStringLiteral("draft")).toObject();
  if (!draft.value(QStringLiteral("id")).isString()) {
    feedback_->setText(release_->isVisible() ? tr("Choose the release group and edition to follow.")
                       : catalog_->isVisible()
                           ? tr("Choose the exact season to search for.")
                           : anchorEntryId_.isEmpty()
                                 ? tr("No matching release was found. Try a Nyaa episode link.")
                                 : tr("Enter an anime title or paste a Nyaa release link for this episode."));
    return;
  }
  const auto startingEpisode = draft.value(QStringLiteral("anchorEpisode")).toInt();
  const auto nextEpisode = draft.value(QStringLiteral("nextEpisode")).toInt();
  const auto matchingRelease = release_->findData(draft.value(QStringLiteral("anchorListingId")).toInteger());
  if (matchingRelease > 0)
    release_->setCurrentIndex(matchingRelease);
  if (!replacing_.isEmpty() && startingEpisode != replacing_.value(QStringLiteral("nextEpisode")).toInt()) {
    feedback_->setText(tr("Choose episode %1, the one this follow is waiting for.")
                           .arg(replacing_.value(QStringLiteral("nextEpisode")).toInt()));
    return;
  }
  draft_ = draft;
  feedback_->clear();
  const auto title = draft.value(QStringLiteral("title")).toString();
  const auto anchor = draft.value(QStringLiteral("anchorTitle")).toString();
  const auto when = draft.value(QStringLiteral("expectedAirAt"));
  summary_->setText(replacing_.isEmpty()
                        ? (anchorEntryId_.isEmpty()
                               ? tr("%1\nStarting release: %2\nNext episode: %3\nEstimated airtime: %4")
                               : tr("%1\nNyaa reference: %2\nNext episode: %3\nEstimated airtime: %4"))
                              .arg(title, anchor)
                              .arg(nextEpisode)
                              .arg(localTime(when, tr("Unknown")))
                        : tr("%1\nNew release rule: %2").arg(title, anchor));
  if (!replacing_.isEmpty())
    return;
  options_->show();
  const auto count = draft.value(QStringLiteral("episodeCount")).toInt();
  overrideAir_->setChecked(false);
  const bool needsMapping = count > 0 && startingEpisode > count;
  overrideNumber_->setChecked(needsMapping);
  overrideNumber_->setEnabled(!needsMapping);
  limit_->setChecked(false);
  airtime_->setDateTime(when.isDouble() ? QDateTime::fromMSecsSinceEpoch(when.toInteger())
                                        : QDateTime::currentDateTime());
  catalogEpisode_->setMaximum(count > 0 ? count : 99999);
  catalogEpisode_->setValue(needsMapping ? 0 : std::max(1, startingEpisode));
  if (needsMapping)
    feedback_->setText(
        tr("The release uses a number outside this MyAnimeList season. Enter the local episode number."));
  finalEpisode_->setMinimum(std::max(1, startingEpisode));
  finalEpisode_->setValue(std::max(nextEpisode, count));
  airtime_->setEnabled(false);
  catalogEpisode_->setEnabled(overrideNumber_->isChecked());
  finalEpisode_->setEnabled(false);
}

void SeriesFollowDialog::submit() {
  if (!confirm_->isEnabled())
    return;
  QJsonObject body{{QStringLiteral("draftId"), draft_.value(QStringLiteral("id"))}};
  const auto done = [this](const QJsonObject &, const QString &error) {
    busy_ = false;
    if (error.isEmpty()) {
      accept();
      return;
    }
    feedback_->setText(error);
    updateActions();
  };
  busy_ = true;
  updateActions();
  if (!replacing_.isEmpty()) {
    body.insert(QStringLiteral("action"), QStringLiteral("replace-source"));
    body.insert(QStringLiteral("revision"), replacing_.value(QStringLiteral("revision")));
    rooms_.seriesFollowAction(room_, replacing_.value(QStringLiteral("id")).toString(), body, this, done);
    return;
  }
  if (overrideAir_->isChecked())
    body.insert(QStringLiteral("expectedAirAt"), airtime_->dateTime().toMSecsSinceEpoch());
  if (overrideNumber_->isChecked())
    body.insert(QStringLiteral("catalogEpisode"), catalogEpisode_->value());
  if (limit_->isChecked())
    body.insert(QStringLiteral("finalEpisode"), finalEpisode_->value());
  rooms_.createSeriesFollow(room_, body, this, done);
}

SeriesManagerDialog::SeriesManagerDialog(RoomClient &rooms, QString room, QWidget *parent)
    : QDialog(parent), rooms_(rooms), room_(std::move(room)) {
  setObjectName(QStringLiteral("SeriesManagerDialog"));
  setWindowTitle(tr("Series follows"));
  setMinimumSize(600, 420);
  auto *layout = new QVBoxLayout(this);
  layout->addWidget(plainLabel(tr("Series follows"), "SectionTitle"));
  feedback_ = plainLabel(tr("Loading follows…"), "muted");
  layout->addWidget(feedback_);
  list_ = new QListWidget;
  list_->setObjectName(QStringLiteral("SeriesFollowList"));
  list_->setAccessibleName(tr("Series followed in this room"));
  list_->setAlternatingRowColors(true);
  list_->setSelectionMode(QAbstractItemView::SingleSelection);
  layout->addWidget(list_, 1);
  details_ = plainLabel();
  layout->addWidget(details_);
  alternative_ = plainLabel();
  layout->addWidget(alternative_);
  auto *tools = new QHBoxLayout;
  add_ = new QPushButton(tr("Follow a series…"));
  add_->setObjectName(QStringLiteral("primary"));
  refresh_ = new QPushButton(tr("Refresh"));
  check_ = new QPushButton(tr("Check now"));
  pause_ = new QPushButton(tr("Pause"));
  more_ = new QToolButton;
  more_->setText(tr("More"));
  more_->setPopupMode(QToolButton::InstantPopup);
  auto *menu = new QMenu(more_);
  more_->setMenu(menu);
  for (auto *widget : {add_, refresh_, check_, pause_})
    tools->addWidget(widget);
  tools->addWidget(more_);
  tools->addStretch();
  layout->addLayout(tools);
  auto *reviews = new QHBoxLayout;
  approve_ = new QPushButton(tr("Use this release once"));
  dismiss_ = new QPushButton(tr("Dismiss alternative"));
  reviews->addWidget(approve_);
  reviews->addWidget(dismiss_);
  reviews->addStretch();
  layout->addLayout(reviews);
  auto *buttons = new QDialogButtonBox(QDialogButtonBox::Close);
  layout->addWidget(buttons);
  connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
  connect(list_, &QListWidget::currentItemChanged, this, &SeriesManagerDialog::updateActions);
  connect(refresh_, &QPushButton::clicked, this, &SeriesManagerDialog::load);
  connect(add_, &QPushButton::clicked, this, [this] { openFollow(); });
  connect(check_, &QPushButton::clicked, this, [this] { action(QStringLiteral("check")); });
  connect(pause_, &QPushButton::clicked, this, [this] {
    action(selected().value(QStringLiteral("status")).toString() == QStringLiteral("paused")
               ? QStringLiteral("resume")
               : QStringLiteral("pause"));
  });
  connect(menu, &QMenu::aboutToShow, this, &SeriesManagerDialog::showActions);
  connect(approve_, &QPushButton::clicked, this, [this] {
    const auto item = selected();
    const auto proposal = item.value(QStringLiteral("alternative")).toObject();
    if (!proposal.isEmpty() && currentHost(rooms_, room_) &&
        QMessageBox::question(
            this, tr("Use this release once?"),
            tr("Add this alternate release to the room. Later episodes will use the original rule.")) ==
            QMessageBox::Yes)
      action(QStringLiteral("approve-alternate"),
             {{QStringLiteral("alternativeId"), proposal.value(QStringLiteral("id"))}}, item);
  });
  connect(dismiss_, &QPushButton::clicked, this, [this] {
    const auto id = selected().value(QStringLiteral("alternative")).toObject().value(QStringLiteral("id"));
    if (id.isString() && currentHost(rooms_, room_))
      action(QStringLiteral("dismiss-alternate"), {{QStringLiteral("alternativeId"), id}});
  });
  connect(&rooms_, &RoomClient::changed, this, [this](const QString &key) {
    if (key == room_)
      updateActions();
  });
  connect(&rooms_, &RoomClient::connectionChanged, this, [this](const QString &key) {
    if (key == room_)
      updateActions();
  });
  connect(&timer_, &QTimer::timeout, this, &SeriesManagerDialog::load);
  timer_.start(30000);
  load();
}

void SeriesManagerDialog::load() {
  if (loading_ || busy_)
    return;
  const auto generation = ++refreshGeneration_;
  loading_ = true;
  updateActions();
  rooms_.loadSeriesFollows(room_, this, [this, generation](const QJsonObject &result, const QString &error) {
    if (generation != refreshGeneration_)
      return;
    loading_ = false;
    if (error.isEmpty()) {
      enabled_ = result.value(QStringLiteral("enabled")).toBool();
      updateRows(result.value(QStringLiteral("items")).toArray());
      feedback_->setText(!enabled_          ? tr("The coordinator has disabled series follows.")
                         : items_.isEmpty() ? tr("This room is not following any series yet.")
                                            : QString());
    } else {
      feedback_->setText(error);
    }
    updateActions();
  });
}

void SeriesManagerDialog::updateRows(const QJsonArray &items) {
  const auto before = selected().value(QStringLiteral("id")).toString();
  const QSignalBlocker blocker(list_);
  items_ = items;
  list_->clear();
  int current = 0;
  for (const auto value : items_) {
    const auto item = value.toObject();
    const auto id = item.value(QStringLiteral("id")).toString();
    const auto title = item.value(QStringLiteral("title")).toString();
    auto *row = new QListWidgetItem(tr("%1 · %2").arg(title, statusLabel(item)), list_);
    row->setData(Qt::UserRole, id);
    row->setToolTip(QStringLiteral("<p>") + title.toHtmlEscaped() + QStringLiteral("</p>"));
    if (id == before)
      current = list_->count() - 1;
  }
  list_->setCurrentRow(list_->count() ? current : -1);
}

QJsonObject SeriesManagerDialog::selected() const {
  const auto *row = list_->currentItem();
  if (!row)
    return {};
  const auto id = row->data(Qt::UserRole).toString();
  for (const auto value : items_) {
    const auto item = value.toObject();
    if (item.value(QStringLiteral("id")).toString() == id)
      return item;
  }
  return {};
}

void SeriesManagerDialog::updateActions() {
  const auto item = selected();
  const auto status = item.value(QStringLiteral("status")).toString();
  const bool active = status == QStringLiteral("active"), paused = status == QStringLiteral("paused");
  const bool connected = rooms_.connected(room_);
  const bool ready = enabled_ && connected && !busy_ && !loading_;
  const auto proposal = item.value(QStringLiteral("alternative")).toObject();
  const bool awaiting = !proposal.isEmpty() && active;
  add_->setEnabled(ready);
  refresh_->setEnabled(connected && !busy_ && !loading_);
  check_->setEnabled(ready && active);
  pause_->setText(paused ? tr("Resume") : tr("Pause"));
  pause_->setEnabled(ready && (active || paused));
  more_->setEnabled(ready && (active || paused));
  const bool host = awaiting && currentHost(rooms_, room_);
  approve_->setVisible(host);
  dismiss_->setVisible(host);
  approve_->setEnabled(ready && host);
  dismiss_->setEnabled(ready && host);
  alternative_->setText(
      awaiting
          ? tr("Alternative awaiting host review: %1").arg(proposal.value(QStringLiteral("title")).toString())
          : QString());
  alternative_->setVisible(awaiting);
  if (item.isEmpty()) {
    details_->clear();
    return;
  }
  const auto message = item.value(QStringLiteral("error")).toString();
  QString details =
      tr("%1\nRelease rule: %2").arg(statusLabel(item), item.value(QStringLiteral("anchorTitle")).toString());
  if (active || paused)
    details += tr("\nNext episode: %1 · Airtime: %2\nLast check: %3 · Next check: %4")
                   .arg(item.value(QStringLiteral("nextEpisode")).toInt())
                   .arg(localTime(item.value(QStringLiteral("expectedAirAt")), tr("Unknown")),
                        localTime(item.value(QStringLiteral("lastCheckedAt")), tr("Pending")),
                        localTime(item.value(QStringLiteral("nextCheckAt")), tr("Not scheduled")));
  if (item.value(QStringLiteral("finalEpisode")).isDouble())
    details += tr("\nFinal release episode: %1").arg(item.value(QStringLiteral("finalEpisode")).toInt());
  if (!message.isEmpty())
    details += QLatin1Char('\n') + message;
  details_->setText(details);
}

void SeriesManagerDialog::action(const QString &name, QJsonObject body, QJsonObject item) {
  if (item.isEmpty())
    item = selected();
  if (item.isEmpty() || busy_ || !enabled_ || !rooms_.connected(room_))
    return;
  ++refreshGeneration_;
  loading_ = false;
  body.insert(QStringLiteral("action"), name);
  body.insert(QStringLiteral("revision"), item.value(QStringLiteral("revision")));
  busy_ = true;
  feedback_->setText(tr("Saving change…"));
  updateActions();
  rooms_.seriesFollowAction(
      room_, item.value(QStringLiteral("id")).toString(), body, this,
      [this](const QJsonObject &result, const QString &error) {
        busy_ = false;
        const auto item = result.value(QStringLiteral("item")).toObject();
        if (error.isEmpty() && !item.isEmpty()) {
          auto next = items_;
          for (qsizetype row = 0; row < next.size(); ++row) {
            if (next[row].toObject().value(QStringLiteral("id")) == item.value(QStringLiteral("id"))) {
              next.replace(row, item);
              break;
            }
          }
          updateRows(next);
          feedback_->clear();
          load();
        } else {
          feedback_->setText(error.isEmpty() ? tr("Refresh to see the current follow status.") : error);
        }
        updateActions();
      });
}

void SeriesManagerDialog::openFollow(const QJsonObject &replacing) {
  auto *dialog = new SeriesFollowDialog(rooms_, room_, this, replacing);
  dialog->setAttribute(Qt::WA_DeleteOnClose);
  connect(dialog, &QDialog::accepted, this, [this] {
    ++refreshGeneration_;
    loading_ = false;
    load();
  });
  dialog->open();
}

void SeriesManagerDialog::editAirtime() {
  const auto item = selected();
  QDialog dialog(this);
  dialog.setWindowTitle(tr("Set next airtime"));
  auto *layout = new QVBoxLayout(&dialog);
  layout->addWidget(plainLabel(tr("Enter the expected airtime in your local time zone.")));
  const auto current = item.value(QStringLiteral("expectedAirAt"));
  auto *date = airtimeEdit(current.isDouble() ? QDateTime::fromMSecsSinceEpoch(current.toInteger())
                                              : QDateTime::currentDateTime());
  layout->addWidget(date);
  auto *buttons = new QDialogButtonBox(QDialogButtonBox::Save | QDialogButtonBox::Cancel);
  auto *clear = buttons->addButton(tr("Airtime unknown"), QDialogButtonBox::ResetRole);
  connect(clear, &QPushButton::clicked, &dialog, [&dialog] { dialog.done(2); });
  connect(buttons, &QDialogButtonBox::accepted, &dialog, &QDialog::accept);
  connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
  layout->addWidget(buttons);
  const int result = dialog.exec();
  if (result == QDialog::Accepted)
    action(QStringLiteral("set-airtime"),
           {{QStringLiteral("expectedAirAt"), date->dateTime().toMSecsSinceEpoch()}}, item);
  else if (result == 2)
    action(QStringLiteral("set-airtime"), {{QStringLiteral("expectedAirAt"), QJsonValue(QJsonValue::Null)}},
           item);
}

void SeriesManagerDialog::editFinale() {
  const auto item = selected();
  bool ok = false;
  const auto boundary = QInputDialog::getInt(
      this, tr("Set final episode"), tr("Final release episode number (0 to use MyAnimeList)"),
      item.value(QStringLiteral("finalEpisodeOverride")).toInt(), 0, 99999, 1, &ok);
  if (ok)
    action(QStringLiteral("set-finale"),
           {{QStringLiteral("finalEpisode"), boundary ? QJsonValue(boundary) : QJsonValue(QJsonValue::Null)}},
           item);
}

void SeriesManagerDialog::linkExisting() {
  if (!rooms_.connected(room_))
    return;
  const auto item = selected();
  QStringList labels, ids;
  for (const auto value : rooms_.room(room_).value(QStringLiteral("entries")).toArray()) {
    const auto entry = value.toObject();
    const auto id = entry.value(QStringLiteral("id")).toString();
    if (id.isEmpty())
      continue;
    auto label = entry.value(QStringLiteral("label")).toString();
    const auto path = entry.value(QStringLiteral("path")).toString();
    if (!path.isEmpty() && path != label)
      label += QStringLiteral(" · ") + path;
    const auto base = label;
    for (int i = 2; labels.contains(label); ++i)
      label = tr("%1 (%2)").arg(base).arg(i);
    labels.append(label);
    ids.append(id);
  }
  if (labels.isEmpty()) {
    feedback_->setText(tr("Add the matching episode to this room first."));
    return;
  }
  const auto episode = item.value(QStringLiteral("nextEpisode")).toInt();
  bool ok = false;
  const auto chosen =
      QInputDialog::getItem(this, tr("Link a room episode"),
                            tr("Which room entry is episode %1?").arg(episode), labels, 0, false, &ok);
  if (ok)
    action(QStringLiteral("link-existing"), {{QStringLiteral("entryId"), ids.value(labels.indexOf(chosen))}},
           item);
}

void SeriesManagerDialog::showActions() {
  auto *menu = more_->menu();
  menu->clear();
  if (selected().value(QStringLiteral("status")).toString() == QStringLiteral("active")) {
    menu->addAction(tr("Set next airtime…"), this, &SeriesManagerDialog::editAirtime);
    menu->addAction(tr("Set final episode…"), this, &SeriesManagerDialog::editFinale);
    menu->addAction(tr("Change release rule…"), this, [this] { openFollow(selected()); });
    menu->addAction(tr("Link a room episode…"), this, &SeriesManagerDialog::linkExisting);
    menu->addAction(tr("Skip this episode…"), this, [this] {
      const auto item = selected();
      const auto episode = item.value(QStringLiteral("nextEpisode")).toInt();
      if (QMessageBox::question(
              this, tr("Skip episode %1?").arg(episode),
              tr("The follow will move to the next episode. You can still add this episode manually.")) ==
          QMessageBox::Yes)
        action(QStringLiteral("skip"), {}, item);
    });
    menu->addSeparator();
  }
  menu->addAction(tr("Stop following…"), this, [this] {
    const auto item = selected();
    if (QMessageBox::question(
            this, tr("Stop following this series?"),
            tr("Episodes already added to the room will remain in the queue or watch history.")) ==
        QMessageBox::Yes)
      action(QStringLiteral("stop"), {}, item);
  });
}
} // namespace wp::ui
