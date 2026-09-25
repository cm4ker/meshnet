package dev.cm4ker.meshnet;

import android.content.Context;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The page's words for what Android draws of the app itself: the radio's ongoing notice and the
 * names of the notice channels, in the language the reader picked in the app. They come with the
 * radio core's settings ({@code words} in the JSON {@link MeshRelay#configure} keeps), so a process
 * Android starts again without the page still speaks it; English until the page has said.
 */
final class Words {
    private Words() {}

    /** The word for {@code key}, with {@code {name}} filled, or {@code english} when the page gave none. */
    static String get(Context context, String key, String english, String name) {
        String text = english;
        String saved = MeshRelay.savedWatch(context);
        if (saved != null) {
            try {
                JSONObject words = new JSONObject(saved).optJSONObject("words");
                String found = words == null ? "" : words.optString(key, "");
                if (!found.isEmpty()) text = found;
            } catch (JSONException e) {
                // Not the page's JSON: English will do.
            }
        }
        return name == null ? text : text.replace("{name}", name);
    }

    static String get(Context context, String key, String english) {
        return get(context, key, english, null);
    }
}
