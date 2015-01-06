﻿
using System;
using System.IO;
using Microsoft.Win32.SafeHandles;

namespace EventStore.Core.TransactionLog.Unbuffered
{
    public unsafe class UnbufferedIOFileStream : Stream
    {
        private readonly byte[] _buffer;
        private readonly int _blockSize;
        private int _bufferedCount;
        private bool _aligned;
        private readonly byte[] _block;
        private long _lastPosition;
        private bool _needsFlush;
        private readonly FileStream _regular;
        private readonly SafeFileHandle _handle;

        private UnbufferedIOFileStream(FileStream regular, SafeFileHandle handle, int blockSize, int internalBufferSize)
        {
            _regular = regular;
            _handle = handle;
            _buffer = new byte[internalBufferSize];
            _block = new byte[blockSize];
            _blockSize = blockSize;
        }

        public static UnbufferedIOFileStream Create(string path,
            FileMode mode,
            FileAccess acc,
            FileShare share,
            bool sequential,
            int internalBufferSize,
            bool writeThrough,
            uint minBlockSize)
        {
            var blockSize = NativeFile.GetDriveSectorSize(path);
            blockSize = blockSize > minBlockSize ? blockSize : minBlockSize;
            if (internalBufferSize%blockSize != 0)
                throw new Exception("buffer size must be aligned to block size of " + blockSize + " bytes");
            var flags = WinNative.FILE_FLAG_NO_BUFFERING;
            if (writeThrough) flags = flags | WinNative.FILE_FLAG_WRITE_THROUGH;

            var handle = NativeFile.Create(path, acc, FileShare.ReadWrite, mode, flags);
            var regular = new FileStream(path, FileMode.OpenOrCreate, FileAccess.Read, FileShare.ReadWrite);
            return new UnbufferedIOFileStream(regular, handle, (int) blockSize, internalBufferSize);
        }

        public override void Flush()
        {
            if (!_needsFlush) return;
            var aligned = (int) GetLowestAlignment(_bufferedCount);
            var positionAligned = GetLowestAlignment(_lastPosition);
            if (!_aligned)
            {
                NativeFile.Seek(_handle, (int) positionAligned, SeekOrigin.Begin);
            }
            if (_bufferedCount%_blockSize == 0)
            {
                InternalWrite(_buffer, (uint) _bufferedCount);
                _lastPosition = positionAligned + _bufferedCount;
                _bufferedCount = 0;
                _aligned = true;
            }
            else
            {
                var left = _bufferedCount - aligned;

                InternalWrite(_buffer, (uint) (aligned + _blockSize)); //write ahead to next block (checkpoint handles)
                _lastPosition = positionAligned + aligned + left;
                SetBuffer(left);
                _bufferedCount = left;
            }
            _needsFlush = false;
        }

        private void InternalWrite(byte[] buffer, uint count)
        {
            var written = 0;
            NativeFile.Write(_handle, buffer, count, ref written);
            //TODO check written
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            var aligned = GetLowestAlignment(offset);
            var left = (int) (offset - aligned);
            Flush();
            SetBuffer(left);
            return offset;
        }

        private long GetLowestAlignment(long offset)
        {
            return offset - (offset%_blockSize);
        }

        public override void SetLength(long value)
        {
            var aligned = GetLowestAlignment(value);
            aligned = aligned == value ? aligned : aligned + _blockSize;
            NativeFile.SetFileSize(_handle, aligned);
            Seek(0, SeekOrigin.Begin);
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            _regular.Position = _lastPosition + _bufferedCount;
            return _regular.Read(buffer, offset, count);
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            var done = false;
            var left = count;
            var current = offset;
            while (!done)
            {
                _needsFlush = true;
                if (_bufferedCount + left < _buffer.Length)
                {
                    CopyBuffer(buffer, current, left);
                    done = true;
                    current += left;
                }
                else
                {
                    var toFill = _buffer.Length - _bufferedCount;
                    CopyBuffer(buffer, current, toFill);
                    Flush();
                    left -= toFill;
                    current += toFill;
                    done = left == 0;
                }
            }
        }

        private void CopyBuffer(byte[] buffer, int offset, int count)
        {
            Buffer.BlockCopy(buffer, offset, _buffer, _bufferedCount, count);
            _bufferedCount += count;
        }

        public override bool CanRead
        {
            get { return false; }
        }

        public override bool CanSeek
        {
            get { return true; }
        }

        public override bool CanWrite
        {
            get { return true; }
        }

        public override long Length
        {
            get { return _regular.Length; }
        }

        public override long Position
        {
            get
            {
                if (_aligned)
                    return _lastPosition + _bufferedCount;
                else
                    return GetLowestAlignment(_lastPosition) + _bufferedCount;
            }
            set { Seek(value, SeekOrigin.Begin); }
        }

        private void SetBuffer(int left)
        {
            Buffer.BlockCopy(_buffer, _buffer.Length - left, _buffer, 0, left);
            _bufferedCount = left;
            _aligned = false;
        }

        protected override void Dispose(bool disposing)
        {
            Flush();
            _regular.Dispose();
            _handle.Close();
        }
    }
}