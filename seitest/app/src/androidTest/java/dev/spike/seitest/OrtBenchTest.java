package dev.spike.seitest;

import android.content.Context;
import android.util.Log;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.HashMap;
import java.util.Map;
import java.util.Random;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.providers.NNAPIFlags;

import java.util.EnumSet;

/**
 * Point 2 of phase 0: VideoSeal embedder latency on a real mid-range phone,
 * via ONNX Runtime (same .onnx validated on desktop — no conversion risk).
 * Inputs: frame (1,1,256,256) + message (1,256). Results in logcat, tag SPIKE.
 */
@RunWith(AndroidJUnit4.class)
public class OrtBenchTest {
    private static final String TAG = "SPIKE";
    private static final int WARMUP = 3, ITERS = 15;

    private byte[] loadModel() throws Exception {
        Context testCtx = InstrumentationRegistry.getInstrumentation().getContext();
        try (InputStream is = testCtx.getAssets().open("embedder.onnx")) {
            return is.readAllBytes();
        }
    }

    private double bench(OrtSession.SessionOptions opts) throws Exception {
        OrtEnvironment env = OrtEnvironment.getEnvironment();
        try (OrtSession session = env.createSession(loadModel(), opts)) {
            Random rnd = new Random(42);
            float[] frame = new float[256 * 256];
            for (int i = 0; i < frame.length; i++) frame[i] = rnd.nextFloat();
            float[] msg = new float[256];
            for (int i = 0; i < msg.length; i++) msg[i] = rnd.nextInt(2);

            Map<String, OnnxTensor> inputs = new HashMap<>();
            inputs.put("frame", OnnxTensor.createTensor(env,
                    FloatBuffer.wrap(frame), new long[]{1, 1, 256, 256}));
            inputs.put("message", OnnxTensor.createTensor(env,
                    FloatBuffer.wrap(msg), new long[]{1, 256}));

            for (int i = 0; i < WARMUP; i++) session.run(inputs).close();
            long t0 = System.nanoTime();
            for (int i = 0; i < ITERS; i++) session.run(inputs).close();
            return (System.nanoTime() - t0) / 1e6 / ITERS;
        }
    }

    @Test
    public void benchCpu() throws Exception {
        OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
        opts.setIntraOpNumThreads(4);
        double ms = bench(opts);
        Log.i(TAG, String.format("ORT_BENCH cpu4 avg_ms=%.1f", ms));
    }

    @Test
    public void benchXnnpack() {
        try {
            OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
            Map<String, String> xnn = new HashMap<>();
            xnn.put("intra_op_num_threads", "4");
            opts.addXnnpack(xnn);
            double ms = bench(opts);
            Log.i(TAG, String.format("ORT_BENCH xnnpack avg_ms=%.1f", ms));
        } catch (Throwable t) {
            Log.i(TAG, "ORT_BENCH xnnpack FAILED: " + t.getMessage());
        }
    }

    @Test
    public void benchNnapi() {
        try {
            OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
            opts.addNnapi(EnumSet.noneOf(NNAPIFlags.class));
            double ms = bench(opts);
            Log.i(TAG, String.format("ORT_BENCH nnapi avg_ms=%.1f", ms));
        } catch (Throwable t) {
            // NNAPI can reject ops — that itself is a spike result
            Log.i(TAG, "ORT_BENCH nnapi FAILED: " + t.getMessage());
        }
    }
}
