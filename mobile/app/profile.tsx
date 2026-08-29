import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { supabase } from "@/lib/supabase";
import { getCurrentContext, AppRole } from "@/lib/session";
import { AppBottomNav } from "@/components/AppBottomNav";

const PREFERENCES = [
  "Warm customer service",
  "Espresso skills",
  "Latte art",
  "Reliability",
  "Speed under pressure",
  "Teamwork",
  "Willingness to learn",
  "Weekend availability",
];
const SHOP_TYPES = [
  "Neighborhood café",
  "Specialty coffee shop",
  "Bakery café",
  "Coffee bar",
  "Roastery",
  "Restaurant café",
  "Mobile coffee cart",
  "Other",
];
const OPEN_DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
type OpenHours = Record<string, string>;
function parseOpeningHours(value?: string | null): OpenHours {
  const result: OpenHours = {};
  String(value || "")
    .split(" · ")
    .forEach((part) => {
      const day = OPEN_DAYS.find(
        (name) => part.startsWith(`${name} `) || part === name,
      );
      if (day)
      result[day] = part === day ? "" : part.slice(day.length + 1).trim();
  });
  if (value && !OPEN_DAYS.some((day) => Object.prototype.hasOwnProperty.call(result, day))) result._legacy = value;
  return result;
}
function formatOpeningHours(value: OpenHours) {
  const formatted = OPEN_DAYS.filter((day) =>
    Object.prototype.hasOwnProperty.call(value, day),
  )
    .map((day) => (value[day]?.trim() ? `${day} ${value[day].trim()}` : day))
    .join(" · ");
  return formatted || value._legacy || "";
}

export default function Profile() {
  const [loading, setLoading] = useState(true),
    [editing, setEditing] = useState(false),
    [profile, setProfile] = useState<any>({}),
    [role, setRole] = useState<AppRole>("barista"),
    [saving, setSaving] = useState(false),
    [openHours, setOpenHours] = useState<OpenHours>({});
  useEffect(() => {
    load();
  }, []);
  async function load() {
    const { user, profile: p, role: r } = await getCurrentContext();
    if (!user) return router.replace("/login");
    setProfile(p || {});
    setOpenHours(parseOpeningHours(p?.open_hours));
    setRole(r || "barista");
    setLoading(false);
  }
  function set(k: string, v: any) {
    setProfile((p: any) => ({ ...p, [k]: v }));
  }
  function togglePreference(value: string) {
    const selected = new Set<string>(profile.barista_preferences || []);
    selected.has(value) ? selected.delete(value) : selected.add(value);
    set("barista_preferences", [...selected]);
  }
  function toggleOpenDay(day: string) {
    setOpenHours((current) => {
      const next = { ...current };
      delete next._legacy;
      Object.prototype.hasOwnProperty.call(next, day)
        ? delete next[day]
        : (next[day] = "");
      return next;
    });
  }
  async function save() {
    setSaving(true);
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      return Alert.alert(
        "Session expired",
        userError?.message || "Please log in again.",
      );
    }
    const payload: any = {
      location: profile.location || null,
      bio: profile.bio || null,
    };
    if (role === "barista") {
      payload.display_name = profile.display_name || null;
      payload.availability = profile.availability || null;
      payload.pay_expectation = profile.pay_expectation || null;
      payload.experience = profile.experience || null;
      payload.skills = String(
        profile.skills_text || profile.skills?.join(", ") || "",
      )
        .split(",")
        .map((x: string) => x.trim())
        .filter(Boolean);
      payload.is_discoverable =
        [
          payload.display_name,
          payload.location,
          payload.bio,
          payload.experience,
          payload.availability,
          payload.pay_expectation,
        ].every(Boolean) && payload.skills.length > 0;
    } else {
      payload.cafe_name = profile.cafe_name || null;
      payload.skills = [];
      payload.experience = null;
      payload.cafe_address = profile.cafe_address || null;
      payload.open_hours = formatOpeningHours(openHours) || null;
      payload.shop_type = profile.shop_type || null;
      payload.barista_preferences = profile.barista_preferences || [];
      payload.is_discoverable =
        [
          payload.cafe_name,
          payload.location,
          payload.bio,
          payload.cafe_address,
          payload.open_hours,
          payload.shop_type,
        ].every(Boolean) && payload.barista_preferences.length > 0;
    }
    const { error } = await supabase
      .from("profiles")
      .update(payload)
      .eq("id", user.id);
    setSaving(false);
    if (error) return Alert.alert("Could not save profile", error.message);
    setProfile((p: any) => ({
      ...p,
      ...payload,
      skills_text: payload.skills?.join(", "),
    }));
    setEditing(false);
  }
  if (loading)
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.center}>
          <ActivityIndicator size="large" color="#321708" />
        </View>
      </SafeAreaView>
    );
  const isBarista = role === "barista",
    name = isBarista
      ? profile.display_name || "Your profile"
      : profile.cafe_name || "Your café";
  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <View>
          <Text style={s.title}>Profile</Text>
          <Text style={s.sub}>
            {isBarista
              ? "Show cafés what makes you special"
              : "Show baristas what makes your café special"}
          </Text>
        </View>
        <Pressable onPress={() => router.push("/settings")} style={s.settings}>
          <Text style={{ fontSize: 20 }}>⚙</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={s.wrap}>
        <View style={s.hero}>
          {!isBarista && profile.bar_picture_url ? (
            <Image
              source={{ uri: profile.bar_picture_url }}
              style={s.barPhoto}
            />
          ) : (
            <View style={s.avatar}>
              <Text style={{ fontSize: 34 }}>{isBarista ? "👤" : "☕"}</Text>
            </View>
          )}
          <Text style={s.name}>{name}</Text>
          <Text style={s.location}>
            {profile.location || "Add your location"}
          </Text>
          <Pressable style={s.edit} onPress={() => setEditing((x) => !x)}>
            <Text style={s.editText}>
              {editing ? "Cancel" : "Edit profile"}
            </Text>
          </Pressable>
        </View>
        {editing ? (
          <View style={s.card}>
            <Field
              label={isBarista ? "Display name" : "Café name"}
              value={
                isBarista ? profile.display_name || "" : profile.cafe_name || ""
              }
              onChange={(v) => set(isBarista ? "display_name" : "cafe_name", v)}
            />
            <Field
              label="Location (city and state)"
              value={profile.location || ""}
              onChange={(v) => set("location", v)}
            />
            <Field
              label={isBarista ? "About" : "About your café"}
              value={profile.bio || ""}
              onChange={(v) => set("bio", v)}
              multiline
            />
            {isBarista ? (
              <>
                <Field
                  label="Skills / specialties"
                  value={
                    profile.skills_text || profile.skills?.join(", ") || ""
                  }
                  onChange={(v) => set("skills_text", v)}
                />
                <Field
                  label="Experience"
                  value={profile.experience || ""}
                  onChange={(v) => set("experience", v)}
                  multiline
                />
                <Field
                  label="Availability"
                  value={profile.availability || ""}
                  onChange={(v) => set("availability", v)}
                />
                <Field
                  label="Desired pay"
                  value={profile.pay_expectation || ""}
                  onChange={(v) => set("pay_expectation", v)}
                />
              </>
            ) : (
              <>
                <Field
                  label="Café address"
                  value={profile.cafe_address || ""}
                  onChange={(v) => set("cafe_address", v)}
                />
              <Text style={s.label}>
                Opening hours — check every day you are open
              </Text>
              <View style={s.hoursList}>
                {OPEN_DAYS.map((day) => {
                  const selected = Object.prototype.hasOwnProperty.call(
                    openHours,
                    day,
                  );
                  return (
                    <View
                      key={day}
                      style={[s.hoursRow, selected && s.hoursRowSelected]}
                    >
                      <Pressable
                        onPress={() => toggleOpenDay(day)}
                        style={s.dayCheck}
                      >
                        <Text
                          style={[
                            s.checkMark,
                            selected && s.checkMarkSelected,
                          ]}
                        >
                          {selected ? "✓" : "○"}
                        </Text>
                        <Text
                          style={[
                            s.dayText,
                            selected && s.choiceTextSelected,
                          ]}
                        >
                          {day}
                        </Text>
                      </Pressable>
                      {selected ? (
                        <TextInput
                          value={openHours[day]}
                          onChangeText={(value) =>
                            setOpenHours((current) => ({
                              ...current,
                              [day]: value,
                            }))
                          }
                          placeholder="7 AM–5 PM"
                          style={s.hoursInput}
                        />
                      ) : null}
                    </View>
                  );
                })}
              </View>
              <Text style={s.hoursHelp}>
                Check the open days, then add the hours for each one.
              </Text>
                <Text style={s.label}>What kind of shop is this?</Text>
                <View style={s.choiceWrap}>
                  {SHOP_TYPES.map((value) => (
                    <Choice
                      key={value}
                      label={value}
                      selected={profile.shop_type === value}
                      onPress={() => set("shop_type", value)}
                    />
                  ))}
                </View>
                <Text style={[s.label, { marginTop: 15 }]}>
                  What do you look for in a barista?
                </Text>
                <View style={s.choiceWrap}>
                  {PREFERENCES.map((value) => (
                    <Choice
                      key={value}
                      label={value}
                      selected={(profile.barista_preferences || []).includes(
                        value,
                      )}
                      onPress={() => togglePreference(value)}
                    />
                  ))}
                </View>
                <Pressable
                  style={s.photoLink}
                  onPress={() =>
                    Linking.openURL(
                      "https://www.baristajobmatch.com/dashboard.html",
                    )
                  }
                >
                  <Text style={s.photoLinkText}>
                    {profile.bar_picture_url
                      ? "Replace optional bar picture on website"
                      : "Add optional bar picture on website"}{" "}
                    →
                  </Text>
                </Pressable>
              </>
            )}
            <Pressable disabled={saving} onPress={save} style={s.primary}>
              <Text style={s.primaryText}>
                {saving ? "Saving…" : "Save profile"}
              </Text>
            </Pressable>
          </View>
        ) : (
          <View style={s.card}>
            <Info
              label={isBarista ? "About" : "About the café"}
              value={profile.bio || "Not added yet"}
            />
            {isBarista ? (
              <>
                <Info
                  label="Skills"
                  value={profile.skills?.join(" · ") || "Not added yet"}
                />
                <Info
                  label="Experience"
                  value={profile.experience || "Not added yet"}
                />
                <Info
                  label="Availability"
                  value={profile.availability || "Not added yet"}
                />
                <Info
                  label="Desired pay"
                  value={profile.pay_expectation || "Not added yet"}
                />
              </>
            ) : (
              <>
                <Info
                  label="Address"
                  value={profile.cafe_address || "Not added yet"}
                />
                <Info
                  label="Opening hours"
                  value={profile.open_hours || "Not added yet"}
                />
                <Info
                  label="Shop type"
                  value={profile.shop_type || "Not added yet"}
                />
                <Info
                  label="What we look for"
                  value={
                    profile.barista_preferences?.join(" · ") || "Not added yet"
                  }
                />
              </>
            )}
            {isBarista && profile.video_path ? (
              <Info label="Coffee showcase" value="Video uploaded ✓" />
            ) : null}
          </View>
        )}
      </ScrollView>
      <AppBottomNav active="profile" role={role} />
    </SafeAreaView>
  );
}

function Choice({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[s.choice, selected && s.choiceSelected]}
    >
      <Text style={[s.checkMark, selected && s.checkMarkSelected]}>
        {selected ? "✓" : "○"}
      </Text>
      <Text style={[s.choiceText, selected && s.choiceTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}
function Field({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        style={[s.input, multiline && s.multi]}
      />
    </View>
  );
}
function Info({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.info}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={s.infoValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fbf7f1" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    padding: 20,
    paddingBottom: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: { fontSize: 31, fontWeight: "900", color: "#321708" },
  sub: { fontSize: 13, color: "#746a61", marginTop: 4 },
  settings: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#eadfd5",
    alignItems: "center",
    justifyContent: "center",
  },
  wrap: { padding: 18, paddingBottom: 30 },
  hero: { alignItems: "center", paddingVertical: 15 },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: "#f3e8de",
    alignItems: "center",
    justifyContent: "center",
  },
  barPhoto: { width: "100%", height: 180, borderRadius: 22 },
  name: { fontSize: 28, fontWeight: "900", color: "#321708", marginTop: 12 },
  location: { fontSize: 14, color: "#746a61", marginTop: 5 },
  edit: {
    marginTop: 14,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "#c9ad99",
    borderRadius: 12,
    backgroundColor: "#fff",
  },
  editText: { fontWeight: "900", color: "#321708" },
  card: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#eadfd5",
    borderRadius: 20,
    padding: 18,
    marginTop: 10,
  },
  field: { marginBottom: 14 },
  label: { fontSize: 12, fontWeight: "900", color: "#5c4435", marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd0c6",
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    color: "#24150d",
    backgroundColor: "#fff",
  },
  multi: { minHeight: 90, textAlignVertical: "top" },
  hoursList: { gap: 8, marginBottom: 7 },
  hoursRow: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: "#ddd0c6",
    borderRadius: 12,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
  },
  hoursRowSelected: { borderColor: "#5f8b50", backgroundColor: "#f7fbf4" },
  dayCheck: { flex: 1, flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  dayText: { fontSize: 13, fontWeight: "800", color: "#5c4435" },
  hoursInput: {
    width: 116,
    borderLeftWidth: 1,
    borderLeftColor: "#dce8d7",
    paddingLeft: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: "#24150d",
  },
  hoursHelp: { fontSize: 11, lineHeight: 16, color: "#746a61", marginBottom: 16 },
  choiceWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ddd0c6",
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 8,
    backgroundColor: "#fff",
  },
  choiceSelected: { borderColor: "#5f8b50", backgroundColor: "#edf3e9" },
  checkMark: { fontSize: 15, color: "#9b8778", marginRight: 5 },
  checkMarkSelected: { color: "#4f7d43" },
  choiceText: { fontSize: 11, fontWeight: "700", color: "#5c4435" },
  choiceTextSelected: { color: "#3f6738" },
  photoLink: {
    marginTop: 18,
    borderWidth: 1,
    borderColor: "#c9ad99",
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
  },
  photoLinkText: { fontWeight: "900", color: "#b75a1d" },
  primary: {
    backgroundColor: "#321708",
    borderRadius: 14,
    padding: 14,
    alignItems: "center",
    marginTop: 18,
  },
  primaryText: { color: "#fff", fontWeight: "900" },
  info: {
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: "#f0e7df",
  },
  infoLabel: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
    fontWeight: "900",
    color: "#9b8778",
  },
  infoValue: { fontSize: 14, lineHeight: 21, color: "#3c3029", marginTop: 5 },
});
