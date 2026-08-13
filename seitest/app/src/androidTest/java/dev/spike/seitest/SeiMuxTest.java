package dev.spike.seitest;

import android.content.Context;
import android.media.Image;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.util.Log;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.nio.ByteBuffer;

import static org.junit.Assert.assertTrue;

/**
 * Point 3 of phase 0: does a custom SEI NAL (user data unregistered),
 * prepended to each encoded access unit before MediaMuxer, survive into
 * the muxed MP4 on this OEM's MediaCodec/MediaMuxer stack?
 * Host side pulls the file and scans for the UUID.
 */
@RunWith(AndroidJUnit4.class)
public class SeiMuxTest {
    private static final String TAG = "SPIKE";
    private static final int WIDTH = 1280, HEIGHT = 720, FRAMES = 60, FPS = 30;
    // 16-byte marker, ASCII only: no 0x00 bytes -> no emulation prevention needed
    private static final byte[] SEI_UUID = "SPIKESEIUUID0001".getBytes();

    /** Annex-B SEI NAL: start code + nal type 6 + payload type 5 (user data unregistered). */
    private static byte[] buildSei(int gopIndex) {
        byte[] payload = String.format("GOP%04d_SIGNATURE_PLACEHOLDER_0123456789ABCDEF", gopIndex).getBytes();
        int size = SEI_UUID.length + payload.length; // fits in one byte (< 255)
        ByteBuffer b = ByteBuffer.allocate(4 + 3 + size + 1);
        b.put(new byte[]{0, 0, 0, 1});
        b.put((byte) 0x06);       // NAL unit type 6 = SEI
        b.put((byte) 0x05);       // payload type 5 = user_data_unregistered
        b.put((byte) size);
        b.put(SEI_UUID);
        b.put(payload);
        b.put((byte) 0x80);       // rbsp trailing bits
        return b.array();
    }

    private static void fillFrame(Image img, int frameIdx) {
        // Moving gradient so the encoder produces non-trivial output
        Image.Plane[] planes = img.getPlanes();
        ByteBuffer y = planes[0].getBuffer();
        int yRowStride = planes[0].getRowStride();
        for (int r = 0; r < HEIGHT; r++) {
            for (int c = 0; c < WIDTH; c++) {
                y.put(r * yRowStride + c, (byte) ((r + c + frameIdx * 4) & 0xFF));
            }
        }
        for (int p = 1; p <= 2; p++) {
            ByteBuffer uv = planes[p].getBuffer();
            int rowStride = planes[p].getRowStride(), pixStride = planes[p].getPixelStride();
            for (int r = 0; r < HEIGHT / 2; r++) {
                for (int c = 0; c < WIDTH / 2; c++) {
                    uv.put(r * rowStride + c * pixStride, (byte) 128);
                }
            }
        }
    }

    @Test
    public void seiSurvivesMuxing() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File out = new File(ctx.getExternalFilesDir(null), "sei_test.mp4");

        MediaFormat fmt = MediaFormat.createVideoFormat("video/avc", WIDTH, HEIGHT);
        fmt.setInteger(MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible);
        fmt.setInteger(MediaFormat.KEY_BIT_RATE, 4_000_000);
        fmt.setInteger(MediaFormat.KEY_FRAME_RATE, FPS);
        fmt.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);

        MediaCodec codec = MediaCodec.createEncoderByType("video/avc");
        codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        codec.start();
        Log.i(TAG, "encoder: " + codec.getName());

        MediaMuxer muxer = new MediaMuxer(out.getAbsolutePath(),
                MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        int track = -1;
        boolean muxerStarted = false;
        int framesIn = 0, samplesOut = 0, seiWritten = 0;
        boolean inputDone = false, outputDone = false;
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

        while (!outputDone) {
            if (!inputDone) {
                int inIdx = codec.dequeueInputBuffer(10_000);
                if (inIdx >= 0) {
                    if (framesIn == FRAMES) {
                        codec.queueInputBuffer(inIdx, 0, 0, 0,
                                MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                        inputDone = true;
                    } else {
                        Image img = codec.getInputImage(inIdx);
                        fillFrame(img, framesIn);
                        long pts = framesIn * 1_000_000L / FPS;
                        codec.queueInputBuffer(inIdx, 0,
                                WIDTH * HEIGHT * 3 / 2, pts, 0);
                        framesIn++;
                    }
                }
            }

            int outIdx = codec.dequeueOutputBuffer(info, 10_000);
            if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                track = muxer.addTrack(codec.getOutputFormat());
                muxer.start();
                muxerStarted = true;
            } else if (outIdx >= 0) {
                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
                    ByteBuffer sample = codec.getOutputBuffer(outIdx);
                    sample.position(info.offset);
                    sample.limit(info.offset + info.size);
                    byte[] sei = buildSei(samplesOut);
                    ByteBuffer withSei = ByteBuffer.allocate(sei.length + info.size);
                    withSei.put(sei).put(sample).flip();
                    MediaCodec.BufferInfo ni = new MediaCodec.BufferInfo();
                    ni.set(0, withSei.limit(), info.presentationTimeUs, info.flags);
                    muxer.writeSampleData(track, withSei, ni);
                    samplesOut++;
                    seiWritten++;
                }
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
                codec.releaseOutputBuffer(outIdx, false);
            }
        }

        codec.stop();
        codec.release();
        if (muxerStarted) muxer.stop();
        muxer.release();

        Log.i(TAG, "SEI_MUX_RESULT path=" + out.getAbsolutePath()
                + " frames=" + framesIn + " samples=" + samplesOut
                + " seiWritten=" + seiWritten + " bytes=" + out.length());
        assertTrue(out.length() > 0);
        assertTrue(seiWritten > 0);
    }
}
