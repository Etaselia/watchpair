#include "http_fetch.h"
#include <QCoreApplication>
#include <QFile>
#include <QFileInfo>
#include <QHostAddress>
#include <QStorageInfo>
#include <QThread>
#include <algorithm>
#include <chrono>
#include <curl/curl.h>
#include <limits>
#include <list>
#include <mutex>
namespace wp {
namespace {
using Clock = std::chrono::steady_clock;
using CurlHandle = std::unique_ptr<CURL, decltype(&curl_easy_cleanup)>;
struct CachedConnection {
  QByteArray policy;
  CurlHandle handle;
};
std::list<CachedConnection> &connectionCache() {
  thread_local std::list<CachedConnection> cache;
  return cache;
}
struct CurlLease {
  CurlHandle handle{nullptr, curl_easy_cleanup};
  QByteArray policy;
  explicit CurlLease(const HttpOptions &options) {
    if (options.reuseConnections) {
      QUrl origin = options.url;
      origin.setPath(QString());
      origin.setQuery(QString());
      origin.setFragment(QString());
      policy = origin.toEncoded() + '\0' + options.bindAddress.toUtf8() + '\0' + options.proxyHost.toUtf8() +
               '\0' + QByteArray::number(options.proxyPort) + '\0' + QByteArray::number(options.allowPrivate);
      auto &cache = connectionCache();
      for (auto it = cache.begin(); it != cache.end(); ++it)
        if (it->policy == policy) {
          handle = std::move(it->handle);
          cache.erase(it);
          break;
        }
    }
    if (!handle)
      handle.reset(curl_easy_init());
  }
  ~CurlLease() {
    if (handle && !policy.isEmpty()) {
      // reset clears request credentials/callbacks while preserving live TLS
      // connections. Pool by route policy so a new bind/proxy cannot reuse an
      // old route. https://curl.se/libcurl/c/curl_easy_reset.html
      curl_easy_reset(handle.get());
      auto &cache = connectionCache();
      cache.push_front({policy, std::move(handle)});
      while (cache.size() > 8)
        cache.pop_back();
    }
  }
  CURL *get() const { return handle.get(); }
  explicit operator bool() const { return bool(handle); }
};
struct Request {
  const HttpOptions &options;
  HttpResult result;
  QFile output;
  double tokens = 0;
  qint64 sent = 0;
  long responseStatus = 0;
  QByteArray contentRange;
  bool bodyAccepted = false;
  Clock::time_point at = Clock::now(), diskAt = Clock::now() - std::chrono::seconds(5);
};
bool privateAddress(const QString &text) {
  QHostAddress address;
  if (!address.setAddress(text))
    return text.compare(QStringLiteral("localhost"), Qt::CaseInsensitive) == 0 ||
           text.endsWith(QStringLiteral(".localhost"), Qt::CaseInsensitive);
  bool ipv4 = false;
  const quint32 ip = address.toIPv4Address(&ipv4);
  if (ipv4)
    return (ip >> 24) == 0 || (ip >> 24) == 10 || (ip >> 24) == 127 || (ip >> 24) >= 224 ||
           (ip >> 16) == 0xa9fe || (ip >> 16) == 0xc0a8 || (ip >> 20) == 0xac1 || (ip >> 22) == 0x191 ||
           (ip >> 17) == 0x6309;
  const auto v6 = address.toIPv6Address();
  return address.isNull() || address.isLoopback() || address.isMulticast() ||
         address == QHostAddress::AnyIPv6 || (v6[0] & 0xfe) == 0xfc ||
         (v6[0] == 0xfe && (v6[1] & 0xc0) == 0x80);
}
int prerequisite(void *data, char *remote, char *, int, int) {
  auto &r = *static_cast<Request *>(data);
  if (!r.options.allowPrivate && r.options.proxyHost.isEmpty() &&
      privateAddress(QString::fromLatin1(remote))) {
    r.result.error = QStringLiteral("A shared URL resolved to a private or local network address. Add the "
                                    "file explicitly on this device instead.");
    return CURL_PREREQFUNC_ABORT;
  }
  return CURL_PREREQFUNC_OK;
}
size_t responseHeader(char *pointer, size_t size, size_t count, void *data) {
  auto &r = *static_cast<Request *>(data);
  const auto length = size * count;
  const QByteArray line(pointer, qsizetype(length));
  if (line.startsWith("HTTP/")) {
    r.responseStatus = line.split(' ').value(1).toLong();
    r.result.acceptedOffset = 0;
    r.result.etag.clear();
    r.contentRange.clear();
    r.bodyAccepted = false;
  } else if (line.left(5).compare("ETag:", Qt::CaseInsensitive) == 0)
    r.result.etag = line.mid(5).trimmed();
  else if (line.left(14).compare("Content-Range:", Qt::CaseInsensitive) == 0)
    r.contentRange = line.mid(14).trimmed();
  else if (line == "\r\n" && r.responseStatus >= 200 && r.responseStatus < 300) {
    const auto offset = r.options.resumeOffset;
    if (r.responseStatus == 206) {
      const auto prefix = QByteArray("bytes ") + QByteArray::number(offset) + '-';
      if (offset <= 0 || r.result.etag != r.options.resumeEtag || !r.contentRange.startsWith(prefix)) {
        r.result.error =
            QStringLiteral("The origin returned an inconsistent resumed range. Restart this download.");
        return 0;
      }
      r.result.acceptedOffset = offset;
    }
    if (r.output.isOpen() &&
        (!r.output.resize(r.result.acceptedOffset) || !r.output.seek(r.result.acceptedOffset))) {
      r.result.error = QStringLiteral("Could not prepare the partial download.");
      return 0;
    }
    r.options.control->received.store(r.result.acceptedOffset);
    r.bodyAccepted = true;
  }
  return length;
}
size_t readBytes(char *pointer, size_t size, size_t count, void *data) {
  auto &r = *static_cast<Request *>(data);
  const auto &control = r.options.control;
  if (control->cancelled.load())
    return CURL_READFUNC_ABORT;
  qint64 n = std::min<qint64>(qint64(size * count), r.options.body.size() - r.sent);
  while (n > 0 && control->uploadBudget) {
    const auto allowed = control->uploadBudget->take(n);
    if (allowed > 0) {
      n = allowed;
      break;
    }
    if (control->cancelled.load())
      return CURL_READFUNC_ABORT;
    QThread::msleep(10);
  }
  if (n > 0) {
    memcpy(pointer, r.options.body.constData() + r.sent, size_t(n));
    r.sent += n;
  }
  return size_t(n);
}
size_t writeBytes(char *pointer, size_t size, size_t count, void *data) {
  auto &r = *static_cast<Request *>(data);
  try {
    if (count && size > std::numeric_limits<size_t>::max() / count)
      return 0;
    const auto length = qint64(size * count);
    // Redirect and error response bodies never contaminate a managed file.
    if (!r.bodyAccepted && !r.options.destination.isEmpty())
      return size * count;
    const auto &control = r.options.control;
    if (control->cancelled.load())
      return 0;
    if (r.options.maximumBytes > 0 && control->received.load() + length > r.options.maximumBytes) {
      r.result.error = QStringLiteral("The response exceeds the expected size or transfer limit.");
      return 0;
    }
    // Enforce the changing device allocation in the worker, with bounded
    // cancellation latency. Each file has an independent fair allocation.
    qint64 written = 0;
    while (written < length) {
      if (control->cancelled.load())
        return 0;
      const auto now = Clock::now();
      const int limit = control->bytesPerSecond.load();
      r.tokens = limit > 0
                     ? std::min<double>(std::max(1, limit / 5),
                                        r.tokens + std::chrono::duration<double>(now - r.at).count() * limit)
                     : double(length);
      r.at = now;
      if (limit > 0 && r.tokens < 1) {
        QThread::msleep(10);
        continue;
      }
      if (!r.options.destination.isEmpty() && now - r.diskAt > std::chrono::milliseconds(500)) {
        r.diskAt = now;
        QStorageInfo disk(r.options.destination);
        if (disk.isValid() && disk.bytesAvailable() >= 0 &&
            disk.bytesAvailable() < qint64(r.options.reserveMiB) * 1024 * 1024) {
          r.result.error = QStringLiteral("The free-space reserve was reached. Free space and resume.");
          return 0;
        }
      }
      auto n = std::min<qint64>(length - written, limit > 0 ? qint64(r.tokens) : length);
      if (control->budget)
        n = control->budget->take(n);
      if (n <= 0) {
        QThread::msleep(10);
        continue;
      }
      if (r.options.destination.isEmpty())
        r.result.body.append(pointer + written, n);
      else if (r.output.write(pointer + written, n) != n) {
        r.result.error = QStringLiteral("Could not write the download. Check free space and folder access.");
        return 0;
      }
      written += n;
      control->received.fetch_add(n);
      if (limit > 0)
        r.tokens -= n;
    }
    return size * count;
  } catch (...) {
    r.result.error = QStringLiteral("Could not store the received data.");
    return 0;
  }
}
int progress(void *data, curl_off_t total, curl_off_t, curl_off_t, curl_off_t) {
  auto &r = *static_cast<Request *>(data);
  if (total > 0)
    r.options.control->total.store(total + r.result.acceptedOffset);
  return r.options.control->cancelled.load() ? 1 : 0;
}
} // namespace
qint64 HttpBudget::take(qint64 wanted) {
  std::lock_guard<std::mutex> lock(mutex_);
  const int limit = bytesPerSecond.load();
  const auto now = Clock::now();
  if (limit <= 0) {
    at_ = now;
    tokens_ = 0;
    return wanted;
  }
  tokens_ = std::min<double>(std::max(1, limit / 5),
                             tokens_ + std::chrono::duration<double>(now - at_).count() * limit);
  at_ = now;
  const auto allowed = std::min(wanted, qint64(tokens_));
  tokens_ -= allowed;
  return allowed;
}
HttpResult fetchHttp(const HttpOptions &options) {
  Request request{options, {}, QFile(options.destination)};
  if (!options.control || !options.url.isValid() ||
      !QStringList{QStringLiteral("http"), QStringLiteral("https")}.contains(options.url.scheme()) ||
      !options.url.userInfo().isEmpty()) {
    request.result.error = QStringLiteral("Invalid HTTP media source.");
    return request.result;
  }
  if (!options.allowPrivate && privateAddress(options.url.host())) {
    request.result.error =
        QStringLiteral("Shared URLs cannot access private or local network addresses automatically.");
    return request.result;
  }
  static std::once_flag init;
  std::call_once(init, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });
  CurlLease curl(options);
  if (!curl) {
    request.result.error = QStringLiteral("Cannot initialize the HTTP transfer.");
    return request.result;
  }
  if (!options.destination.isEmpty() &&
      (QFileInfo(options.destination).isSymLink() || !request.output.open(QIODevice::ReadWrite))) {
    request.result.error = QStringLiteral("Cannot open the managed download file.");
    return request.result;
  }
  const auto url = options.url.toEncoded(), bind = options.bindAddress.toUtf8(),
             proxy = options.proxyHost.toUtf8();
  curl_easy_setopt(curl.get(), CURLOPT_URL, url.constData());
  curl_easy_setopt(curl.get(), CURLOPT_PROTOCOLS_STR, "http,https");
  curl_easy_setopt(curl.get(), CURLOPT_REDIR_PROTOCOLS_STR,
                   options.url.scheme() == QStringLiteral("https") ? "https" : "http,https");
  curl_easy_setopt(curl.get(), CURLOPT_FOLLOWLOCATION, options.followRedirects ? 1L : 0L);
  curl_easy_setopt(curl.get(), CURLOPT_MAXREDIRS, 3L);
  curl_easy_setopt(curl.get(), CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(curl.get(), CURLOPT_CONNECTTIMEOUT, 15L);
  if (options.timeoutSeconds > 0)
    curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT, long(options.timeoutSeconds));
  curl_easy_setopt(curl.get(), CURLOPT_PREREQFUNCTION, prerequisite);
  curl_easy_setopt(curl.get(), CURLOPT_PREREQDATA, &request);
  curl_easy_setopt(curl.get(), CURLOPT_LOW_SPEED_LIMIT, 1L);
  curl_easy_setopt(curl.get(), CURLOPT_LOW_SPEED_TIME, 60L);
  curl_easy_setopt(curl.get(), CURLOPT_USERAGENT, "WatchPair/2");
  curl_easy_setopt(curl.get(), CURLOPT_SSL_VERIFYPEER, 1L);
  curl_easy_setopt(curl.get(), CURLOPT_SSL_VERIFYHOST, 2L);
  const auto roots = QCoreApplication::applicationDirPath() + QStringLiteral("/certs/ca-bundle.crt");
  const auto rootBytes = QFile::encodeName(roots);
  if (QFileInfo::exists(roots))
    curl_easy_setopt(curl.get(), CURLOPT_CAINFO, rootBytes.constData());
  curl_easy_setopt(curl.get(), CURLOPT_PROXY, proxy.constData()); // ignore ambient HTTP_PROXY/NO_PROXY
  if (!proxy.isEmpty()) {
    curl_easy_setopt(curl.get(), CURLOPT_PROXYTYPE, static_cast<long>(CURLPROXY_SOCKS5_HOSTNAME));
    curl_easy_setopt(curl.get(), CURLOPT_PROXYPORT, long(options.proxyPort));
    curl_easy_setopt(curl.get(), CURLOPT_NOPROXY, "");
  }
  if (!bind.isEmpty())
    curl_easy_setopt(curl.get(), CURLOPT_INTERFACE, bind.constData());
  if (options.head)
    curl_easy_setopt(curl.get(), CURLOPT_NOBODY, 1L);
  const auto method = options.method.toLatin1();
  curl_slist *rawHeaders = nullptr;
  const auto range = QByteArray::number(options.resumeOffset) + '-';
  if (options.resumeOffset > 0 && options.resumeEtag.startsWith('"') && options.resumeEtag.endsWith('"') &&
      !options.resumeEtag.contains('\r') && !options.resumeEtag.contains('\n')) {
    curl_easy_setopt(curl.get(), CURLOPT_RANGE, range.constData());
    rawHeaders = curl_slist_append(rawHeaders, (QByteArray("If-Range: ") + options.resumeEtag).constData());
  }
  for (auto it = options.headers.begin(); it != options.headers.end(); ++it) {
    if (it.key().contains('\r') || it.key().contains('\n') || it.value().contains('\r') ||
        it.value().contains('\n')) {
      request.result.error = QStringLiteral("Invalid HTTP header.");
      curl_slist_free_all(rawHeaders);
      return request.result;
    }
    rawHeaders = curl_slist_append(rawHeaders, (it.key() + ": " + it.value()).constData());
  }
  rawHeaders = curl_slist_append(rawHeaders, "Expect:");
  std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)> headers(rawHeaders, curl_slist_free_all);
  curl_easy_setopt(curl.get(), CURLOPT_HTTPHEADER, headers.get());
  if (!method.isEmpty()) {
    curl_easy_setopt(curl.get(), CURLOPT_CUSTOMREQUEST, method.constData());
    curl_easy_setopt(curl.get(), CURLOPT_UPLOAD, 1L);
    curl_easy_setopt(curl.get(), CURLOPT_INFILESIZE_LARGE, curl_off_t(options.body.size()));
    curl_easy_setopt(curl.get(), CURLOPT_READFUNCTION, readBytes);
    curl_easy_setopt(curl.get(), CURLOPT_READDATA, &request);
  }
  curl_easy_setopt(curl.get(), CURLOPT_WRITEFUNCTION, writeBytes);
  curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, &request);
  curl_easy_setopt(curl.get(), CURLOPT_HEADERFUNCTION, responseHeader);
  curl_easy_setopt(curl.get(), CURLOPT_HEADERDATA, &request);
  curl_easy_setopt(curl.get(), CURLOPT_XFERINFOFUNCTION, progress);
  curl_easy_setopt(curl.get(), CURLOPT_XFERINFODATA, &request);
  curl_easy_setopt(curl.get(), CURLOPT_NOPROGRESS, 0L);
  const auto code = curl_easy_perform(curl.get());
  long status = 0;
  curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &status);
  request.result.status = int(status);
  char *final = nullptr;
  curl_easy_getinfo(curl.get(), CURLINFO_EFFECTIVE_URL, &final);
  if (final)
    request.result.finalUrl = QString::fromUtf8(final);
  request.result.cancelled = options.control->cancelled.load();
  if (request.output.isOpen() && !request.output.flush() && request.result.error.isEmpty())
    request.result.error = QStringLiteral("Could not commit download data to storage.");
  if (!request.result.cancelled && request.result.error.isEmpty()) {
    if (code != CURLE_OK)
      request.result.error = QStringLiteral("HTTP transfer failed (%1). Check connectivity, the bound "
                                            "interface, proxy, and TLS certificate settings.")
                                 .arg(int(code));
    else if (status < 200 || status >= 300)
      request.result.error =
          QStringLiteral("The media origin returned HTTP %1. Check the link and access permissions.")
              .arg(status);
  }
  return request.result;
}
} // namespace wp
