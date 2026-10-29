#include "direct_download.h"
#include "acquisition_state.h"
#include "owned_storage.h"
#include "transfer_engine.h"
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>
#include <QUuid>
#include <QtConcurrent>
namespace wp {
DirectDownloads::DirectDownloads(LocalStore &store, LibraryService &library, TransferEngine &transfers,
                                 QObject *parent)
    : QObject(parent), store_(store), library_(library), transfers_(transfers) {
  pool_.setMaxThreadCount(4);
  budget_ = transfers_.downloadBudget();
  connect(&library_, &LibraryService::identified, this, [this](const QString &op, const QJsonObject &file) {
    if (!identifying_.contains(op))
      return;
    const auto id = identifying_.take(op);
    auto it = jobs_.find(id);
    if (it == jobs_.end())
      return;
    auto &job = *it->second;
    const auto sha = job.row.value(QStringLiteral("expectedSha256")).toString();
    const auto size = job.row.value(QStringLiteral("expectedSize")).toInteger();
    if ((!sha.isEmpty() && sha != file.value(QStringLiteral("sha256")).toString()) ||
        (size > 0 && size != file.value(QStringLiteral("size")).toInteger())) {
      failure(
          job,
          QStringLiteral(
              "The URL returned different content. Locate the matching copy or refresh the room source."));
      return;
    }
    auto next = job.row;
    next.insert(QStringLiteral("file"), file);
    next.insert(QStringLiteral("state"), QStringLiteral("Ready"));
    next.insert(QStringLiteral("error"), QString());
    try {
      persist(job, next);
      emit ready(id, file);
    } catch (const AppError &e) {
      failure(job, e.message());
    }
    emit changed();
  });
  connect(&library_, &LibraryService::failed, this, [this](const QString &op, const QString &message) {
    if (!identifying_.contains(op))
      return;
    const auto id = identifying_.take(op);
    auto it = jobs_.find(id);
    if (it != jobs_.end())
      failure(*it->second, message);
  });
  connect(&timer_, &QTimer::timeout, this, [this] {
    const auto config = transfers_.configuration();
    for (auto &[id, job] : jobs_)
      if (job->control) {
        bool routeChanged = false;
        for (const auto &key :
             {QStringLiteral("bind"), QStringLiteral("proxyHost"), QStringLiteral("proxyPort")})
          routeChanged |= config.value(key) != job->route.value(key);
        if (routeChanged || config.value(QStringLiteral("offline")).toBool() ||
            !transfers_.hasDownloadSlot(QStringLiteral("direct:") + id))
          job->control->cancelled.store(true);
        job->row.insert(QStringLiteral("received"), job->control->received.load());
        job->row.insert(QStringLiteral("total"), job->control->total.load());
        const auto now = QDateTime::currentMSecsSinceEpoch();
        if (now - job->sampledAt >= 1000) {
          const auto bytes = job->control->received.load();
          job->row.insert(QStringLiteral("rate"),
                          job->sampledAt
                              ? std::max<qint64>(0, (bytes - job->bytesLast) * 1000 / (now - job->sampledAt))
                              : 0);
          job->bytesLast = bytes;
          job->sampledAt = now;
        }
      }
    if (!config.value(QStringLiteral("offline")).toBool())
      for (const auto &[id, job] : jobs_) {
        try {
          applyDemand(id);
        } catch (const AppError &e) {
          failure(*job, e.message());
        }
      }
    allocate();
    emit changed();
  });
  timer_.start(250);
}
DirectDownloads::~DirectDownloads() {
  timer_.stop();
  for (auto &[id, job] : jobs_)
    if (job->control)
      job->control->cancelled.store(true);
  pool_.waitForDone();
}
void DirectDownloads::persist(Job &job, const QJsonObject &value) {
  store_.put(QStringLiteral("direct"), value.value(QStringLiteral("id")).toString(), value);
  job.row = value;
}
void DirectDownloads::failure(Job &job, const QString &message) {
  if (job.control)
    job.control->cancelled.store(true);
  auto next = job.row;
  next.insert(QStringLiteral("state"), QStringLiteral("Error"));
  next.insert(QStringLiteral("error"), message);
  try {
    persist(job, next);
  } catch (...) {
    job.row = next;
  }
  emit failed(next.value(QStringLiteral("id")).toString(), message);
  emit changed();
}
QString DirectDownloads::add(const QUrl &url, const QString &label, const QString &sha, qint64 size,
                             bool automatic) {
  if (!url.isValid() ||
      !QStringList{QStringLiteral("http"), QStringLiteral("https")}.contains(url.scheme()) ||
      url.host().isEmpty() || !url.userInfo().isEmpty())
    throw AppError(QStringLiteral("DIRECT_URL"),
                   QStringLiteral("Use an HTTP or HTTPS media URL without embedded credentials."));
  if ((!sha.isEmpty() && !QRegularExpression(QStringLiteral("^[a-f0-9]{64}$")).match(sha).hasMatch()) ||
      size < 0)
    throw AppError(QStringLiteral("DIRECT_IDENTITY"), QStringLiteral("Invalid expected media identity."));
  for (const auto &[id, job] : jobs_)
    if (job->row.value(QStringLiteral("url")).toString() == url.toString() &&
        job->row.value(QStringLiteral("expectedSha256")).toString() == sha)
      return id;
  for (auto value : store_.all(QStringLiteral("retained-media"))) {
    auto row = value.toObject();
    if (row.value(QStringLiteral("kind")).toString() != QStringLiteral("direct") ||
        row.value(QStringLiteral("url")).toString() != url.toString() ||
        row.value(QStringLiteral("expectedSha256")).toString() != sha || !owned::directory(row))
      continue;
    const auto id = row.value(QStringLiteral("id")).toString();
    row.insert(QStringLiteral("label"), label);
    row.insert(QStringLiteral("expectedSize"), size);
    row.insert(QStringLiteral("automatic"), automatic);
    row.insert(QStringLiteral("manualPaused"), true);
    row.insert(QStringLiteral("manualActive"), false);
    row.insert(QStringLiteral("userPaused"), false);
    row.insert(QStringLiteral("resumePending"), false);
    row.insert(QStringLiteral("neverStarted"), true);
    row.insert(QStringLiteral("state"),
               LibraryService::unchanged(row.value(QStringLiteral("file")).toObject())
                   ? QStringLiteral("Ready")
                   : QStringLiteral("Paused"));
    row.insert(QStringLiteral("error"), QString());
    auto restored = std::make_unique<Job>();
    restored->row = row;
    store_.transaction([&] {
      store_.put(QStringLiteral("direct"), id, row);
      store_.remove(QStringLiteral("retained-media"), id);
    });
    jobs_.emplace(id, std::move(restored));
    emit changed();
    return id;
  }
  const auto id = QUuid::createUuid().toString(QUuid::WithoutBraces);
  auto job = std::make_unique<Job>();
  QJsonObject row{{QStringLiteral("id"), id},
                  {QStringLiteral("label"), label},
                  {QStringLiteral("url"), url.toString()},
                  {QStringLiteral("expectedSha256"), sha},
                  {QStringLiteral("expectedSize"), size},
                  {QStringLiteral("automatic"), automatic},
                  {QStringLiteral("state"), QStringLiteral("Paused")},
                  {QStringLiteral("manualPaused"), true},
                  {QStringLiteral("neverStarted"), true}};
  const auto existing = sha.isEmpty() ? QJsonObject() : library_.match(sha);
  if (!existing.isEmpty()) {
    row.insert(QStringLiteral("file"), existing);
    row.insert(QStringLiteral("external"), true);
    row.insert(QStringLiteral("state"), QStringLiteral("Ready"));
  } else {
    const auto nonce = QUuid::createUuid().toString(QUuid::WithoutBraces);
    const auto root = owned::allocate(transfers_.configuration()
                                          .value(QStringLiteral("downloadRoot"))
                                          .toString(store_.profile() + QStringLiteral("/downloads")),
                                      id, nonce);
    row.insert(QStringLiteral("root"), root);
    row.insert(QStringLiteral("nonce"), nonce);
    auto suffix = QFileInfo(url.path()).suffix().left(12);
    suffix.remove(QRegularExpression(QStringLiteral("[^A-Za-z0-9]")));
    if (suffix.isEmpty())
      suffix = QStringLiteral("bin");
    row.insert(QStringLiteral("path"), root + QStringLiteral("/media.") + suffix);
  }
  persist(*job, row);
  jobs_.emplace(id, std::move(job));
  emit changed();
  return id;
}
void DirectDownloads::restore() {
  for (auto item : store_.all(QStringLiteral("direct"))) {
    auto row = item.toObject();
    const auto id = row.value(QStringLiteral("id")).toString();
    if (jobs_.contains(id))
      continue;
    if (!LibraryService::unchanged(row.value(QStringLiteral("file")).toObject())) {
      row.insert(QStringLiteral("state"), QStringLiteral("Paused"));
      row.insert(QStringLiteral("manualPaused"), true);
      row.insert(QStringLiteral("error"),
                 QStringLiteral("Interrupted download. Resume validates the origin before continuing."));
    }
    auto job = std::make_unique<Job>();
    persist(*job, row);
    jobs_.emplace(id, std::move(job));
  }
  emit changed();
}
void DirectDownloads::resume(const QString &id, bool userAction) {
  auto it = jobs_.find(id);
  if (it == jobs_.end())
    throw AppError(QStringLiteral("DIRECT_MISSING"), QStringLiteral("This download no longer exists."));
  auto &job = *it->second;
  if (job.row.value(QStringLiteral("moving")).toBool())
    throw AppError(QStringLiteral("STORAGE_BUSY"),
                   QStringLiteral("Finish the storage move before resuming."));
  if (job.control) {
    if (job.control->cancelled.load() && userAction) {
      auto next = job.row;
      next.insert(QStringLiteral("resumePending"), true);
      next.insert(QStringLiteral("manualActive"), true);
      next.insert(QStringLiteral("userPaused"), false);
      persist(job, next);
    }
    return;
  }
  if (job.row.value(QStringLiteral("state")).toString() == QStringLiteral("Verifying"))
    return;
  if (!userAction && job.row.value(QStringLiteral("userPaused")).toBool())
    return;
  const auto existing = job.row.value(QStringLiteral("file")).toObject();
  if (LibraryService::unchanged(existing)) {
    if (userAction) {
      auto next = job.row;
      next.insert(QStringLiteral("state"), QStringLiteral("Ready"));
      next.insert(QStringLiteral("userPaused"), false);
      next.insert(QStringLiteral("manualPaused"), false);
      persist(job, next);
      emit changed();
    }
    emit ready(id, existing);
    return;
  }
  const auto config = transfers_.configuration();
  if (config.value(QStringLiteral("offline")).toBool())
    throw AppError(QStringLiteral("OFFLINE"), QStringLiteral("Turn off offline mode before downloading."));
  const auto path = job.row.value(QStringLiteral("path")).toString();
  if (!owned::file(job.row, path))
    throw AppError(QStringLiteral("STORAGE_OWNERSHIP"),
                   QStringLiteral("Download storage is unavailable or its path changed."));
  auto next = job.row;
  next.insert(QStringLiteral("state"), QStringLiteral("Downloading"));
  next.insert(QStringLiteral("manualPaused"), false);
  next.insert(QStringLiteral("neverStarted"), false);
  next.insert(QStringLiteral("error"), QString());
  next.insert(QStringLiteral("resumePending"), false);
  if (userAction) {
    next.insert(QStringLiteral("manualActive"), true);
    next.insert(QStringLiteral("userPaused"), false);
  }
  persist(job, next);
  transfers_.setExternalWork(QStringLiteral("direct:") + id, true,
                             job.row.value(QStringLiteral("foreground")).toBool());
  if (!transfers_.hasDownloadSlot(QStringLiteral("direct:") + id)) {
    next.insert(QStringLiteral("state"), QStringLiteral("Queued"));
    persist(job, next);
    emit changed();
    return;
  }
  job.control = std::make_shared<HttpControl>();
  job.route = config;
  job.control->budget = budget_;
  allocate();
  HttpOptions options;
  options.url = QUrl(job.row.value(QStringLiteral("url")).toString());
  options.destination = path + QStringLiteral(".part");
  options.control = job.control;
  options.allowPrivate = !job.row.value(QStringLiteral("automatic")).toBool();
  const auto etag = job.row.value(QStringLiteral("etag")).toString().toLatin1();
  if (etag.startsWith('"') && etag.endsWith('"') && QFileInfo(options.destination).size() > 0) {
    options.resumeEtag = etag;
    options.resumeOffset = QFileInfo(options.destination).size();
  }
  options.bindAddress = config.value(QStringLiteral("bind")).toString();
  options.proxyHost = config.value(QStringLiteral("proxyHost")).toString();
  options.proxyPort = config.value(QStringLiteral("proxyPort")).toInt(1080);
  options.reserveMiB = config.value(QStringLiteral("reserveMiB")).toInt(1024);
  options.maximumBytes = job.row.value(QStringLiteral("expectedSize")).toInteger();
  auto *watcher = new QFutureWatcher<HttpResult>(this);
  connect(watcher, &QFutureWatcher<HttpResult>::finished, this, [this, watcher, id] {
    try {
      finished(id, watcher->result());
    } catch (const std::exception &e) {
      auto it = jobs_.find(id);
      if (it != jobs_.end())
        failure(*it->second, QString::fromUtf8(e.what()));
    }
    watcher->deleteLater();
  });
  watcher->setFuture(QtConcurrent::run(&pool_, [options] { return fetchHttp(options); }));
  emit changed();
}
void DirectDownloads::allocate() {
  int count = 0;
  for (const auto &[id, job] : jobs_)
    if (job->control)
      ++count;
  transfers_.setExternalTraffic(count);
}
void DirectDownloads::finished(const QString &id, const HttpResult &result) {
  auto it = jobs_.find(id);
  if (it == jobs_.end())
    return;
  auto &job = *it->second;
  const auto received = job.control ? job.control->received.load() : 0;
  job.control.reset();
  transfers_.setExternalWork(QStringLiteral("direct:") + id, false);
  auto metadata = job.row;
  metadata.insert(QStringLiteral("etag"), QString::fromLatin1(result.etag));
  metadata.insert(QStringLiteral("rate"), 0);
  persist(job, metadata);
  allocate();
  if (result.cancelled) {
    auto next = job.row;
    next.insert(QStringLiteral("state"), QStringLiteral("Paused"));
    next.insert(QStringLiteral("manualPaused"), true);
    persist(job, next);
    emit changed();
    if (next.value(QStringLiteral("resumePending")).toBool())
      QTimer::singleShot(0, this, [this, id] {
        try {
          resume(id);
        } catch (const AppError &e) {
          emit failed(id, e.message());
        }
      });
    return;
  }
  if (!result.error.isEmpty() || (result.status != 200 && result.status != 206) || received <= 0) {
    failure(job, result.error.isEmpty() ? QStringLiteral("The origin returned no complete media file.")
                                        : result.error);
    return;
  }
  const auto path = job.row.value(QStringLiteral("path")).toString();
  if ((QFileInfo::exists(path) && !QFile::remove(path)) ||
      !QFile::rename(path + QStringLiteral(".part"), path)) {
    failure(job, QStringLiteral("Could not commit the completed managed copy."));
    return;
  }
  auto next = job.row;
  next.insert(QStringLiteral("state"), QStringLiteral("Verifying"));
  persist(job, next);
  identifying_.insert(library_.identify(path), id);
  emit changed();
}
void DirectDownloads::pause(const QString &id) {
  auto it = jobs_.find(id);
  if (it == jobs_.end())
    return;
  auto &job = *it->second;
  auto next = job.row;
  next.insert(QStringLiteral("manualPaused"), true);
  next.insert(QStringLiteral("userPaused"), true);
  next.insert(QStringLiteral("manualActive"), false);
  next.insert(QStringLiteral("neverStarted"), false);
  next.insert(QStringLiteral("state"), QStringLiteral("Paused"));
  next.insert(QStringLiteral("resumePending"), false);
  persist(job, next);
  transfers_.setExternalWork(QStringLiteral("direct:") + id, false);
  if (job.control)
    job.control->cancelled.store(true);
  emit changed();
}
void DirectDownloads::setDemand(const QString &key, const QString &id, bool wanted) {
  const QJsonObject row{
      {QStringLiteral("id"), key}, {QStringLiteral("download"), id}, {QStringLiteral("wanted"), wanted}};
  const auto previous = store_.get(QStringLiteral("direct-demand"), key);
  if (previous != row)
    store_.put(QStringLiteral("direct-demand"), key, row);
  applyDemand(id);
  const auto old = previous.value(QStringLiteral("download")).toString();
  if (!old.isEmpty() && old != id)
    applyDemand(old);
}
void DirectDownloads::removeDemand(const QString &key) {
  const auto id =
      store_.get(QStringLiteral("direct-demand"), key).value(QStringLiteral("download")).toString();
  store_.remove(QStringLiteral("direct-demand"), key);
  if (!id.isEmpty())
    applyDemand(id);
}
void DirectDownloads::applyDemand(const QString &id) {
  auto it = jobs_.find(id);
  if (it == jobs_.end())
    return;
  auto &job = *it->second;
  if (job.row.value(QStringLiteral("moving")).toBool())
    return;
  bool wanted = job.row.value(QStringLiteral("manualActive")).toBool();
  for (auto value : store_.find(QStringLiteral("direct-demand"), QStringLiteral("download"), id))
    wanted = wanted || value.toObject().value(QStringLiteral("wanted")).toBool();
  const auto state = job.row.value(QStringLiteral("state")).toString();
  transfers_.setExternalWork(QStringLiteral("direct:") + id,
                             wanted && !job.row.value(QStringLiteral("userPaused")).toBool() &&
                                 state != QStringLiteral("Ready") && state != QStringLiteral("Verifying") &&
                                 state != QStringLiteral("Error"),
                             job.row.value(QStringLiteral("foreground")).toBool());
  if (!wanted && job.control)
    job.control->cancelled.store(true);
  else if (wanted && !job.control &&
           (state == QStringLiteral("Paused") || state == QStringLiteral("Queued")) &&
           !job.row.value(QStringLiteral("userPaused")).toBool())
    resume(id, false);
}
void DirectDownloads::remove(const QString &id) {
  auto it = jobs_.find(id);
  if (it == jobs_.end())
    return;
  if (it->second->control || it->second->row.value(QStringLiteral("moving")).toBool() ||
      it->second->row.value(QStringLiteral("state")).toString() == QStringLiteral("Verifying") ||
      it->second->row.value(QStringLiteral("pinned")).toBool())
    throw AppError(
        QStringLiteral("DOWNLOAD_BUSY"),
        QStringLiteral("Pause the download, wait for verification and unpin it before removing it."));
  store_.transaction([&] {
    refuseRoomAcquisition(store_, QStringLiteral("download"), id);
    if (!it->second->row.value(QStringLiteral("external")).toBool()) {
      auto retained = it->second->row;
      retained.insert(QStringLiteral("kind"), QStringLiteral("direct"));
      store_.put(QStringLiteral("retained-media"), id, retained);
    }
    store_.remove(QStringLiteral("direct"), id);
  });
  jobs_.erase(it);
  transfers_.forgetExternalWork(QStringLiteral("direct:") + id);
  emit removed(id);
  allocate();
  emit changed();
}
void DirectDownloads::setPinned(const QString &id, bool pinned) {
  auto it = jobs_.find(id);
  if (it == jobs_.end())
    return;
  auto next = it->second->row;
  next.insert(QStringLiteral("pinned"), pinned);
  persist(*it->second, next);
  emit changed();
}
bool DirectDownloads::busy(const QString &id) const {
  const auto it = jobs_.find(id);
  return it != jobs_.end() &&
         (it->second->control ||
          it->second->row.value(QStringLiteral("state")).toString() == QStringLiteral("Verifying"));
}
void DirectDownloads::reload(const QString &id) {
  auto it = jobs_.find(id);
  if (it == jobs_.end())
    return;
  if (it->second->control)
    throw AppError(QStringLiteral("STORAGE_BUSY"), QStringLiteral("Wait for the download to stop."));
  it->second->row = store_.get(QStringLiteral("direct"), id);
  emit changed();
}
QJsonArray DirectDownloads::downloads() const {
  QJsonArray result;
  for (const auto &[id, job] : jobs_) {
    auto row = job->row;
    const auto order = transfers_.queueOrder(QStringLiteral("direct:") + id);
    row.insert(QStringLiteral("order"), order == INT_MAX ? -1 : order);
    row.insert(QStringLiteral("downRate"), row.value(QStringLiteral("rate")));
    result.append(row);
  }
  return result;
}
QJsonObject DirectDownloads::download(const QString &id) const {
  auto it = jobs_.find(id);
  return it == jobs_.end() ? QJsonObject() : it->second->row;
}
} // namespace wp
