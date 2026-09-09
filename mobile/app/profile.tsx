import { dashboardPrism as prism, prismPanel } from '@/lib/dashboardPrism';
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { supabase } from "@/lib/supabase";
import { needsMediaLibraryPermission, normalizeOptionalGender, buildProfileUpdate, getProfileReadiness, getProfileSaveMessage, persistProfileUpdate } from "@/lib/profilePrivacy";
import { getCurrentContext, requireCurrentUser, AppRole } from "@/lib/session";
import { AppBottomNav } from "@/components/AppBottomNav";
import {
  floridaCityFromLocation,
} from "@/lib/floridaLocation";

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
const AVAILABILITY_OPTIONS = [
  "Weekday mornings",
  "Weekday afternoons",
  "Weekday evenings",
  "Saturday",
  "Sunday",
  "Full-time",
  "Part-time",
  "Flexible",
];
const GENDER_OPTIONS = [
  { value: "", label: "Prefer not to say" },
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
];
type SelectedMedia = {
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
};
function parseAvailability(value?: string | null) {
  const parts = String(value || "")
    .split(" · ")
    .filter(Boolean);
  return {
    selected: parts.filter((part) => AVAILABILITY_OPTIONS.includes(part)),
    notes: parts
      .filter((part) => !AVAILABILITY_OPTIONS.includes(part))
      .join(" · "),
  };
}
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
  if (
    value &&
    !OPEN_DAYS.some((day) => Object.prototype.hasOwnProperty.call(result, day))
  )
    result._legacy = value;
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
    [locationCity, setLocationCity] = useState(""),
    [openHours, setOpenHours] = useState<OpenHours>({}),
    [availability, setAvailability] = useState<string[]>([]),
    [availabilityNotes, setAvailabilityNotes] = useState(""),
    [profilePhoto, setProfilePhoto] = useState<SelectedMedia | null>(null),
    [barPicture, setBarPicture] = useState<SelectedMedia | null>(null),
    [coffeeVideo, setCoffeeVideo] = useState<SelectedMedia | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [savedProfile, setSavedProfile] = useState<any>({});
  const accountId = useRef<string | null>(null);
  const saveInProgress = useRef(false);
  const active = useRef(false);
  const generation = useRef(0);
  useFocusEffect(useCallback(() => {
    active.current = true;
    const version = ++generation.current;
    void load(version);
    return () => { active.current = false; generation.current += 1; };
  }, []));
  function restoreDraft(saved: any) {
    setProfile({ ...saved, skills_text: (saved.skills || []).join(", "), preferred_city: floridaCityFromLocation(saved.preferred_city) });
    setLocationCity(floridaCityFromLocation(saved.location));
    setOpenHours(parseOpeningHours(saved.open_hours));
    const value = parseAvailability(saved.availability);
    setAvailability(value.selected);
    setAvailabilityNotes(value.notes);
    setProfilePhoto(null); setBarPicture(null); setCoffeeVideo(null);
  }
  async function load(version = ++generation.current) {
    setLoading(true); setLoadError(false); setEditing(false);
    try {
    const { user, profile: p, role: r } = await getCurrentContext();
    if (!active.current || generation.current !== version) return;
    if (!user) return router.replace("/login");
    if (!r) return router.replace({ pathname: "/signup", params: { complete: "1" } });
    const demographicsResult = r === "barista"
      ? await supabase.from("profile_demographics").select("date_of_birth,gender_identity").eq("user_id", user.id).maybeSingle()
      : { data: null, error: null };
    const { data: demographics, error: demographicsError } = demographicsResult;
    if (demographicsError) throw demographicsError;
    await requireCurrentUser(user.id);
    if (!active.current || generation.current !== version) return;
    const saved = { ...p, ...demographics };
    accountId.current = user.id;
    setSavedProfile(saved);
    restoreDraft(saved);
    setRole(r);
    } catch {
      if (active.current && generation.current === version) setLoadError(true);
    } finally {
      if (active.current && generation.current === version) setLoading(false);
    }
  }
  function toggleEditing() {
    if (saveInProgress.current) return;
    generation.current += 1;
    restoreDraft(savedProfile);
    setEditing(value => !value);
  }
  function set(k: string, v: any) {
    if (saveInProgress.current) return;
    setProfile((p: any) => ({ ...p, [k]: v }));
  }
  function togglePreference(value: string) {
    const selected = new Set<string>(profile.barista_preferences || []);
    selected.has(value) ? selected.delete(value) : selected.add(value);
    set("barista_preferences", [...selected]);
  }
  function toggleAvailability(value: string) {
    setAvailability((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    );
  }
  async function pickMedia(kind: "photo" | "bar" | "video") {
    if (saveInProgress.current) return;
    const version = generation.current;
    try {
      // Use the system picker without broad library access on Android and for photos.
      // Original iOS videos require permission with SDK 54 pass-through export.
      if (needsMediaLibraryPermission(Platform.OS, kind)) {
        const permission =
          await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          const buttons: Parameters<typeof Alert.alert>[2] = [
            { text: "Not now", style: "cancel" },
          ];
          if (!permission.canAskAgain)
            buttons.push({
              text: "Open Settings",
              onPress: () => Linking.openSettings(),
            });
          Alert.alert(
            "Video access permission",
            "Access is needed to add your original video. You can skip this optional upload and keep using BaristaMatch.",
            buttons,
          );
          return;
        }

      }
      const result = await ImagePicker.launchImageLibraryAsync({
        legacy: false,
        exif: false,
        mediaTypes: kind === "video" ? "videos" : "images",
        allowsEditing: false,
        quality: 1,
        preferredAssetRepresentationMode:
          kind === "video"
            ? ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current
            : ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      if (result.canceled || !active.current || generation.current !== version || saveInProgress.current) return;

      const picked = result.assets?.[0];
      if (!picked?.uri) throw new Error("No media was selected. Please try again.");
      const asset: SelectedMedia = {
        uri: picked.uri,
        name:
          picked.fileName ||
          `${kind}-${Date.now()}.${kind === "video" ? "mp4" : "jpg"}`,
        size: picked.fileSize,
        mimeType: picked.mimeType || undefined,
      };
      const limit = kind !== "video" ? 5 * 1024 * 1024 : 50 * 1024 * 1024;
      if ((asset.size || 0) > limit)
        return Alert.alert(
          `${kind !== "video" ? "Photo" : "Video"} is too large`,
          kind !== "video"
            ? "Choose a photo smaller than 5 MB."
            : "Choose a video smaller than 50 MB.",
        );
      if (kind === "photo") setProfilePhoto(asset);
      else if (kind === "bar") setBarPicture(asset);
      else setCoffeeVideo(asset);
    } catch (error: any) {
      if (!active.current || generation.current !== version) return;
      Alert.alert(
        "Could not open Photos",
        error?.message || "Please try choosing your photo or video again.",
      );
    }
  }
  async function uploadAsset(
    asset: SelectedMedia,
    bucket: string,
    path: string,
  ) {
    const response = await fetch(asset.uri);
    if (!response.ok) throw new Error("The selected file could not be opened.");
    const bytes = await response.arrayBuffer();
    const limit = bucket === "coffee-videos" ? 50 * 1024 * 1024 : 5 * 1024 * 1024;
    if (!bytes.byteLength || bytes.byteLength > limit) throw new Error("Choose a nonempty file within the displayed size limit.");
    const { error } = await supabase.storage.from(bucket).upload(path, bytes, {
      contentType: asset.mimeType || undefined,
      upsert: true,
    });
    if (error) throw error;
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
    if (saveInProgress.current || !editing || !accountId.current) return;
    const userId = accountId.current;
    const version = generation.current;
    const stillCurrent = () => active.current && generation.current === version;
    const assertCurrent = async () => {
      if (!stillCurrent()) throw new Error("The profile editor was closed. Reopen it to continue.");
      await requireCurrentUser(userId);
      if (!stillCurrent()) throw new Error("The profile editor was closed. Reopen it to continue.");
    };
    // Capture every draft field before uploads; no asynchronous step reads a newer draft.
    let payload: Record<string, any>;
    try {
      payload = buildProfileUpdate(profile, role, { locationCity, availability: [...availability], availabilityNotes, openHours: formatOpeningHours({ ...openHours }) });
    } catch (error: any) {
      return Alert.alert("Check your profile", error.message);
    }
    const demographics = { date_of_birth: profile.date_of_birth, gender_identity: role === "barista" ? normalizeOptionalGender(profile.gender_identity) : null };
    const media = { photo: profilePhoto, bar: barPicture, video: coffeeVideo };
    saveInProgress.current = true;
    setSaving(true);
    try {
      await assertCurrent();
      for (const kind of ["photo", "bar", "video"] as const) {
        const asset = media[kind];
        if (!asset || (kind === "bar" && role === "barista")) continue;
        const ext = (asset.name.split(".").pop() || (kind === "video" ? "mp4" : "jpg")).toLowerCase();
        const allowed = kind === "video" ? ["mp4", "mov", "m4v", "webm"] : ["jpg", "jpeg", "png", "webp", "heic", "heif"];
        if (!allowed.includes(ext)) throw new Error("Choose a supported image or video format.");
        const bucket = kind === "video" ? "coffee-videos" : "cafe-images";
        const path = `${userId}/${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
        await assertCurrent();
        await uploadAsset(asset, bucket, path);
        await assertCurrent();
        const value = kind === "video" ? path : supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
        payload[kind === "video" ? "video_path" : kind === "bar" ? "bar_picture_url" : "avatar_url"] = value;
      }
      payload.is_discoverable = getProfileReadiness({ ...profile, ...payload }, role).complete && !profile.suspended_at;
      const saved = await persistProfileUpdate(supabase, userId, role, payload, demographics, assertCurrent);
      if (!stillCurrent()) return;
      const confirmed = { ...saved, ...(role === "barista" ? demographics : {}) };
      setSavedProfile(confirmed);
      restoreDraft(confirmed);
      setEditing(false);
      Alert.alert("Profile saved", getProfileSaveMessage(confirmed, role));
    } catch (error: any) {
      if (stillCurrent()) Alert.alert("Could not finish saving", error?.message || "Check your connection and try again. Your draft is still here.");
    } finally {
      saveInProgress.current = false;
      setSaving(false);
    }
  }
  if (loadError) return <SafeAreaView style={s.safe}><View style={s.center}>
    <Text style={s.sub}>Your profile could not be loaded. Check your connection and try again.</Text>
    <Pressable accessibilityRole="button" onPress={() => void load()} style={s.primary}><Text style={s.primaryText}>Try again</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => router.replace("/login")}><Text style={s.sub}>Return to login</Text></Pressable>
  </View></SafeAreaView>;
  if (loading)
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.center}>
          <ActivityIndicator size="large" color={prism.ink} />
        </View>
      </SafeAreaView>
    );
  const isBarista = role === "barista",
    name = isBarista
      ? profile.display_name || "Your profile"
      : profile.cafe_name || "Your café";
  const previewAvatarUri = profilePhoto?.uri || profile.avatar_url || null;
  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <View style={s.headerCopy}>
          <Text style={s.title}>Profile</Text>
          <Text style={s.sub}>
            {isBarista
              ? "Show cafés what makes you special"
              : "Show baristas what makes your café special"}
          </Text>
        </View>
        <Pressable disabled={saving} accessibilityRole="button" accessibilityLabel="Open account settings" onPress={() => router.push("/settings")} style={s.settings}>
          <Text allowFontScaling={false} style={{ fontSize: 20 }}>⚙</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={s.wrap}>
        <View style={s.hero}>
          {previewAvatarUri ? (
            <Image
              source={{ uri: previewAvatarUri }}
              style={s.profilePhoto}
            />
          ) : !isBarista && profile.bar_picture_url ? (
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
          <Pressable disabled={saving} accessibilityRole="button" style={s.edit} onPress={toggleEditing}>
            <Text style={s.editText}>
              {saving ? "Saving profile…" : editing ? "Cancel" : "Edit profile"}
            </Text>
          </Pressable>
        </View>
        <Text style={s.privateHelp}>{getProfileReadiness(savedProfile, role).visible ? "Visible in discovery" : "Hidden in discovery"} · {getProfileReadiness(savedProfile, role).complete ? "Profile complete" : `Still needed: ${getProfileReadiness(savedProfile, role).missing.join(", ")}`}</Text>
        {editing ? (
          <View pointerEvents={saving ? "none" : "auto"} style={s.card}>
            <View style={s.visibilityCard}>
              <View style={s.visibilityRow}>
                <Text style={s.visibilityLabel}>Show my profile in discovery</Text>
                <Switch
                  accessibilityLabel="Show my profile in discovery"
                  accessibilityHint="Save your profile to apply this choice."
                  disabled={saving}
                  value={profile.visible_to_cafes === true}
                  onValueChange={(value) => set("visible_to_cafes", value)}
                  trackColor={{ false: prism.line, true: prism.accent }}
                />
              </View>
              <Text style={s.privateHelp}>Save your profile to apply this choice. Turning it off hides your profile from new discovery results. Existing matches and conversations stay available.</Text>
              <Text style={s.privateHelp}>{savedProfile.suspended_at ? "Your profile stays hidden while your account is suspended, even when this preference is on." : "Your profile can appear only when all required details are complete and your account is active."}</Text>
            </View>
            <Field
              editable={!saving}
              label={isBarista ? "Display name" : "Café name"}
              value={
                isBarista ? profile.display_name || "" : profile.cafe_name || ""
              }
              onChange={(v) => set(isBarista ? "display_name" : "cafe_name", v)}
            />
            <MediaPicker
              label={
                isBarista ? "Profile picture" : "Café logo or profile picture"
              }
              value={
                profilePhoto?.name ||
                (profile.avatar_url
                  ? "Current picture saved ✓"
                  : "No picture selected")
              }
              buttonLabel={
                profile.avatar_url || profilePhoto
                  ? "Replace picture"
                  : "Choose picture"
              }
              onPress={() => pickMedia("photo")}
              help={
                profilePhoto
                  ? "Preview ready · Tap Save profile below to upload"
                  : "Up to 5 MB · JPG, PNG, or WebP"
              }
            />
            <Field
              editable={!saving}
              label="City"
              value={locationCity}
              onChange={setLocationCity}
              placeholder="Miami"
            />
            <Field
              label="State"
              value="Florida (FL)"
              onChange={() => {}}
              editable={false}
            />
            {isBarista ? (
              <View style={s.privateCard}>
                <Text style={s.privateTitle}>Private account information</Text>
                <Text style={s.label}>Date of birth</Text>
                <TextInput
                  editable={!saving}
                  accessibilityLabel="Date of birth"
                  value={profile.date_of_birth || ""}
                  onChangeText={(value) => set("date_of_birth", value.replace(/[^0-9-]/g, "").slice(0, 10))}
                  placeholder="YYYY-MM-DD"
                  keyboardType="numbers-and-punctuation"
                  maxLength={10}
                  style={s.dateInput}
                />
                <Text style={[s.label, { marginTop: 15 }]}>Gender (optional)</Text>
                <View style={s.choiceWrap}>
                  {GENDER_OPTIONS.map((option) => (
                    <Choice
                      key={option.value}
                      label={option.label}
                      selected={(profile.gender_identity || "") === option.value}
                      onPress={() => set("gender_identity", option.value)}
                    />
                  ))}
                </View>
                <Text style={s.privateHelp}>Date of birth is required for age eligibility. Gender is optional and used only for aggregate platform reporting; it never affects visibility or matching. Choose Prefer not to say to remove a previous selection. Your date of birth, age, and gender are never shown to cafés or on your marketplace profile.</Text>
              </View>
            ) : null}
            {isBarista ? (
              <>
                <Field
              editable={!saving}
                  label="Preferred work city (optional)"
                  value={profile.preferred_city || ""}
                  onChange={(v) => set("preferred_city", v)}
                  placeholder={locationCity || "Miami"}
                />
                <Field
                  label="Preferred work state"
                  value="Florida (FL)"
                  onChange={() => {}}
                  editable={false}
                />
                <Field
              editable={!saving}
                  label="Preferred ZIP code"
                  value={profile.preferred_postal_code || ""}
                  onChange={(v) => set("preferred_postal_code", v)}
                />
                <Text style={s.privateHelp}>Discovery uses your saved city and optional exact ZIP code. Distance-based searching is not available yet.</Text>
              </>
            ) : null}
            <Field
              editable={!saving}
              label={isBarista ? "About you" : "About your café"}
              value={profile.bio || ""}
              onChange={(v) => set("bio", v)}
              multiline
            />
            {isBarista ? (
              <>
                <Field
              editable={!saving}
                  label="Skills"
                  value={
                    profile.skills_text ?? profile.skills?.join(", ") ?? ""
                  }
                  onChange={(v) => set("skills_text", v)}
                />
                <Text style={[s.label, { marginTop: 15 }]}>
                  Availability — check all that apply
                </Text>
                <View style={s.choiceWrap}>
                  {AVAILABILITY_OPTIONS.map((value) => (
                    <Choice
                      key={value}
                      label={value}
                      selected={availability.includes(value)}
                      onPress={() => toggleAvailability(value)}
                    />
                  ))}
                </View>
                <Field
              editable={!saving}
                  label="Other availability details (optional)"
                  value={availabilityNotes}
                  onChange={setAvailabilityNotes}
                />
                <Field
              editable={!saving}
                  label="Experience"
                  value={profile.experience || ""}
                  onChange={(v) => set("experience", v)}
                  multiline
                />
                <Field
              editable={!saving}
                  label="Desired pay"
                  value={profile.pay_expectation || ""}
                  onChange={(v) => set("pay_expectation", v)}
                />
                <MediaPicker
                  label="Optional skills video"
                  value={
                    coffeeVideo?.name ||
                    (profile.video_path
                      ? "Current video saved ✓"
                      : "No video selected")
                  }
                  buttonLabel={
                    profile.video_path || coffeeVideo
                      ? "Replace video"
                      : "Choose video"
                  }
                  onPress={() => pickMedia("video")}
                  help="Show latte art, espresso preparation, or customer-service skills · 15–60 seconds recommended · up to 50 MB"
                />
              </>
            ) : (
              <>
                <Field
              editable={!saving}
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
                  editable={!saving}
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
                <MediaPicker
                  label="Optional picture of the bar"
                  value={
                    barPicture?.name ||
                    (profile.bar_picture_url
                      ? "Current bar picture saved ✓"
                      : "No picture selected")
                  }
                  buttonLabel={
                    profile.bar_picture_url || barPicture
                      ? "Replace picture"
                      : "Choose picture"
                  }
                  onPress={() => pickMedia("bar")}
                  help="Show baristas the workspace · up to 5 MB"
                />
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
  placeholder,
  editable = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
  editable?: boolean;
}) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        placeholder={placeholder}
        editable={editable}
        style={[s.input, multiline && s.multi, !editable && s.inputDisabled]}
      />
    </View>
  );
}
function MediaPicker({
  label,
  value,
  buttonLabel,
  onPress,
  help,
}: {
  label: string;
  value: string;
  buttonLabel: string;
  onPress: () => void;
  help?: string;
}) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <View style={s.mediaRow}>
        <Text style={s.mediaValue} numberOfLines={1}>
          {value}
        </Text>
        <Pressable style={s.mediaButton} onPress={onPress}>
          <Text style={s.mediaButtonText}>{buttonLabel}</Text>
        </Pressable>
      </View>
      {help ? <Text style={s.mediaHelp}>{help}</Text> : null}
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
  visibilityCard: { padding: 15, borderWidth: 1, borderColor: prism.line, borderRadius: 14, backgroundColor: prism.soft, marginBottom: 18 },
  visibilityRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  visibilityLabel: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 21, color: prism.ink, fontWeight: '700' },
  safe: { flex: 1, backgroundColor: prism.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    padding: 20,
    paddingBottom: 10,
    gap: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  // Reserve the trailing action width; long subtitles must wrap, not push it off screen.
  headerCopy: { flex: 1, minWidth: 0 },
  title: { fontSize: 31, fontWeight: '700', color: prism.ink },
  sub: { fontSize: 13, color: prism.muted, marginTop: 4 },
  settings: {
    flexShrink: 0,
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: prism.surface,
    borderWidth: 1,
    borderColor: prism.line,
    alignItems: "center",
    justifyContent: "center",
  },
  wrap: { padding: 18, paddingBottom: 30 },
  hero: { alignItems: "center", paddingVertical: 15 },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: prism.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  barPhoto: { width: "100%", height: 180, borderRadius: 22 },
  profilePhoto: { width: 88, height: 88, borderRadius: 44 },
  name: { maxWidth: "100%", textAlign: "center", fontSize: 28, fontWeight: '700', color: prism.ink, marginTop: 12 },
  location: { maxWidth: "100%", textAlign: "center", fontSize: 14, color: prism.muted, marginTop: 5 },
  edit: {
    marginTop: 14,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: prism.line,
    borderRadius: 12,
    backgroundColor: prism.accentSoft,
  },
  editText: { fontWeight: '700', color: prism.accent },
  card: { ...prismPanel,
    backgroundColor: prism.surface,
    borderWidth: 1,
    borderColor: prism.line,
    borderRadius: 24,
    padding: 18,
    marginTop: 10,
  },
  field: { marginBottom: 14 },
  label: { fontSize: 12, fontWeight: '700', color: prism.ink, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: prism.line,
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    color: prism.ink,
    backgroundColor: prism.surface,
  },
  inputDisabled: { backgroundColor: prism.soft, color: prism.muted },
  multi: { minHeight: 90, textAlignVertical: "top" },
  mediaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: prism.line,
    borderRadius: 12,
    padding: 8,
    backgroundColor: prism.surface,
  },
  mediaValue: { flexGrow: 1, flexShrink: 1, flexBasis: 100, minWidth: 0, fontSize: 12, color: prism.muted, paddingLeft: 4 },
  mediaButton: {
    maxWidth: "100%",
    flexShrink: 0,
    backgroundColor: prism.accentSoft,
    borderRadius: 9,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  mediaButtonText: { flexShrink: 1, textAlign: "center", fontSize: 11, fontWeight: '700', color: prism.accent },
  mediaHelp: { fontSize: 10, lineHeight: 15, color: prism.muted, marginTop: 5 },
  hoursList: { gap: 8, marginBottom: 7 },
  hoursRow: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: prism.line,
    borderRadius: 12,
    paddingHorizontal: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    backgroundColor: prism.surface,
  },
  hoursRowSelected: { borderColor: "#5f8b50", backgroundColor: "#f7fbf4" },
  dayCheck: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 120,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
  },
  dayText: { flexShrink: 1, fontSize: 13, fontWeight: '700', color: prism.ink },
  hoursInput: {
    flexGrow: 1,
    width: 116,
    borderLeftWidth: 1,
    borderLeftColor: "#dce8d7",
    paddingLeft: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: prism.ink,
  },
  hoursHelp: {
    fontSize: 11,
    lineHeight: 16,
    color: prism.muted,
    marginBottom: 16,
  },
  choiceWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: prism.line,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 8,
    backgroundColor: prism.surface,
  },
  choiceSelected: { borderColor: "#5f8b50", backgroundColor: "#edf3e9" },
  checkMark: { fontSize: 15, color: prism.muted, marginRight: 5 },
  checkMarkSelected: { color: "#4f7d43" },
  choiceText: { flexShrink: 1, fontSize: 11, fontWeight: "700", color: prism.ink },
  choiceTextSelected: { color: "#3f6738" },
  privateCard: { marginTop: 16, padding: 16, borderWidth: 1, borderColor: prism.line, borderRadius: 16, backgroundColor: prism.soft },
  privateTitle: { fontSize: 15, fontWeight: '700', color: prism.ink, marginBottom: 2 },
  dateInput: { marginTop: 7, borderWidth: 1, borderColor: prism.line, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, backgroundColor: prism.surface, color: prism.ink, fontSize: 15, fontWeight: "700" },
  privateHelp: {
    fontSize: 11,
    lineHeight: 17,
    color: prism.muted,
    marginTop: 10,
    marginBottom: 10,
  },
  photoLink: {
    marginTop: 18,
    borderWidth: 1,
    borderColor: prism.line,
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
  },
  photoLinkText: { fontWeight: '700', color: prism.accent },
  primary: {
    backgroundColor: prism.accent,
    borderRadius: 14,
    padding: 14,
    alignItems: "center",
    marginTop: 18,
  },
  primaryText: { color: prism.surface, fontWeight: '700' },
  info: {
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: prism.line,
  },
  infoLabel: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
    fontWeight: '700',
    color: prism.muted,
  },
  infoValue: { fontSize: 14, lineHeight: 21, color: prism.ink, marginTop: 5 },
});
