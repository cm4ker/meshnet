package dev.cm4ker.meshnet;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Why the app, or its page, stopped lately: what Android records of the app's own ends (Android 11
 * and later), and the page's renderer, a process of its own, gone while the app went on
 * ({@link MainActivity}). Shown in Radio › About, so a phone that keeps losing the app can say why.
 */
final class AppExits {
    private static final String PREFS = "meshnet.exits";
    private static final String PAGE_KEY = "page";
    private static final int KEPT = 5;

    private AppExits() {}

    /** The page went while the app stayed: its renderer killed or crashed, or the page let go for memory. */
    static void notePage(Context context, String reason) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray kept;
        try {
            kept = new JSONArray(prefs.getString(PAGE_KEY, "[]"));
        } catch (JSONException broken) {
            kept = new JSONArray();
        }
        JSONArray next = new JSONArray();
        try {
            next.put(stop(System.currentTimeMillis(), "page", reason, null));
            for (int i = 0; i < kept.length() && next.length() < KEPT; i++) next.put(kept.get(i));
        } catch (JSONException impossible) {
            return;
        }
        prefs.edit().putString(PAGE_KEY, next.toString()).apply();
    }

    /** The latest stops of either kind, newest first. */
    static JSArray recent(Context context) {
        List<JSONObject> stops = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ActivityManager manager = context.getSystemService(ActivityManager.class);
            List<ApplicationExitInfo> exits = manager == null
                ? new ArrayList<>()
                : manager.getHistoricalProcessExitReasons(context.getPackageName(), 0, KEPT * 3);
            for (ApplicationExitInfo exit : exits) {
                // The app itself; its page's renderers end on their own terms, and the pages that
                // went before their time are kept here (notePage).
                if (!context.getPackageName().equals(exit.getProcessName())) continue;
                try {
                    stops.add(stop(exit.getTimestamp(), "app", reason(exit.getReason()), detail(exit)));
                } catch (JSONException impossible) {
                    // Left out.
                }
            }
        }
        try {
            JSONArray page = new JSONArray(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PAGE_KEY, "[]"));
            for (int i = 0; i < page.length(); i++) stops.add(page.getJSONObject(i));
        } catch (JSONException broken) {
            // None kept, then.
        }
        stops.sort((a, b) -> Long.compare(b.optLong("at"), a.optLong("at")));
        JSArray out = new JSArray();
        for (int i = 0; i < stops.size() && i < KEPT; i++) out.put(stops.get(i));
        return out;
    }

    private static JSONObject stop(long at, String what, String reason, String detail) throws JSONException {
        return new JSObject().put("at", at).put("what", what).put("reason", reason).put("detail", detail);
    }

    private static String reason(int code) {
        switch (code) {
            case ApplicationExitInfo.REASON_EXIT_SELF:
                return "closed itself";
            case ApplicationExitInfo.REASON_SIGNALED:
                return "killed";
            case ApplicationExitInfo.REASON_LOW_MEMORY:
                return "killed for memory";
            case ApplicationExitInfo.REASON_CRASH:
            case ApplicationExitInfo.REASON_CRASH_NATIVE:
                return "crashed";
            case ApplicationExitInfo.REASON_ANR:
                return "stopped responding";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE:
                return "stopped for using too much";
            case ApplicationExitInfo.REASON_USER_REQUESTED:
            case ApplicationExitInfo.REASON_USER_STOPPED:
                return "stopped by you";
            case ApplicationExitInfo.REASON_PACKAGE_UPDATED:
                return "updated";
            case ApplicationExitInfo.REASON_OTHER:
                return "stopped by the system";
            default:
                return "stopped (" + code + ")";
        }
    }

    /** What Android adds, and whether the app was in sight or kept up by its service when it went. */
    private static String detail(ApplicationExitInfo exit) {
        String where;
        int importance = exit.getImportance();
        if (importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) {
            where = "on screen";
        } else if (importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE) {
            where = "linked in the background";
        } else {
            where = "in the background";
        }
        String said = exit.getDescription();
        return said == null || said.isEmpty() ? where : where + "; " + said;
    }
}
