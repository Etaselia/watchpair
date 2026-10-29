#pragma once
#include <QByteArray>
#include <QMap>
#include <QString>
#include <QUrl>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
namespace wp {
struct HttpBudget {
  std::atomic_int bytesPerSecond{0};
  qint64 take(qint64 wanted);

private:
  std::mutex mutex_;
  double tokens_ = 0;
  std::chrono::steady_clock::time_point at_ = std::chrono::steady_clock::now();
};
struct HttpControl {
  std::atomic_bool cancelled{false};
  std::atomic_int bytesPerSecond{0}; // zero means unlimited
  std::atomic<qint64> received{0}, total{0};
  std::shared_ptr<HttpBudget> budget;
  std::shared_ptr<HttpBudget> uploadBudget;
};
struct HttpOptions {
  QUrl url;
  QString destination, bindAddress, proxyHost;
  int proxyPort = 1080, reserveMiB = 0;
  qint64 maximumBytes = 16 * 1024 * 1024;
  bool head = false;
  bool followRedirects = true, allowPrivate = true;
  bool reuseConnections = false;
  QByteArray body;
  QMap<QByteArray, QByteArray> headers;
  QString method;
  int timeoutSeconds = 0;
  // Resume only with a strong validator. A changed origin returning 200
  // replaces the partial copy; a 206 must match both validator and offset.
  qint64 resumeOffset = 0;
  QByteArray resumeEtag;
  std::shared_ptr<HttpControl> control;
};
struct HttpResult {
  QByteArray body;
  QString error, finalUrl;
  QByteArray etag;
  qint64 acceptedOffset = 0;
  int status = 0;
  bool cancelled = false;
};
// Blocking worker function. Native curl supplies explicit interface binding,
// SOCKS5 DNS proxying, TLS verification, and bounded streaming writes on both
// platforms; no transfer silently bypasses the device's network policy.
HttpResult fetchHttp(const HttpOptions &options);
} // namespace wp
