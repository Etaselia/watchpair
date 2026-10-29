#pragma once
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <libtorrent/create_torrent.hpp>
#include <stdexcept>
namespace wp::test {
// Deterministic v1 fixture generation, independent of libtorrent's threaded
// convenience hasher. Actual acquisitions still use libtorrent's disk verifier.
inline void setV1Hashes(libtorrent::create_torrent &torrent, const libtorrent::file_storage &files,
                        const QString &root) {
  QByteArray block;
  int index = 0;
  const auto length = files.piece_length();
  auto commit = [&] {
    const auto hash = QCryptographicHash::hash(block, QCryptographicHash::Sha1);
    torrent.set_hash(libtorrent::piece_index_t(index++), libtorrent::sha1_hash(hash.constData()));
    block.clear();
  };
  for (auto file : files.file_range()) {
    QFile input(QDir(root).filePath(QString::fromStdString(files.file_path(file))));
    if (!files.pad_file_at(file) && !input.open(QIODevice::ReadOnly))
      throw std::runtime_error("Cannot open a fixture file for hashing");
    qint64 left = files.file_size(file);
    while (left > 0) {
      const auto n = std::min<qint64>(length - block.size(), left);
      const auto data = files.pad_file_at(file) ? QByteArray(n, '\0') : input.read(n);
      if (data.size() != n)
        throw std::runtime_error("A fixture file changed during hashing");
      block.append(data);
      left -= n;
      if (block.size() == length)
        commit();
    }
  }
  if (!block.isEmpty())
    commit();
}
} // namespace wp::test
