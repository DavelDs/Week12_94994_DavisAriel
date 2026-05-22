import { useState, useEffect } from "react";
import { Text, View, Button, Platform } from "react-native";
import Constants from "expo-constants";

type NotificationsModule = typeof import("expo-notifications");
type ExpoNotification = import("expo-notifications").Notification;
type ExpoNotificationResponse =
  import("expo-notifications").NotificationResponse;

const isExpoGoOnAndroid =
  Platform.OS === "android" && Constants.appOwnership === "expo";

type FirebaseFunctionName = "firestore" | "fcm";

type FunctionCounter = {
  success: number;
  failed: number;
};

type FirebaseStats = Record<FirebaseFunctionName, FunctionCounter>;

type FunctionResult = {
  success: boolean;
  message?: string;
};

const initialFirebaseStats: FirebaseStats = {
  firestore: { success: 0, failed: 0 },
  fcm: { success: 0, failed: 0 },
};

async function getNotificationsModule() {
  if (isExpoGoOnAndroid) {
    return null;
  }

  const Notifications = await import("expo-notifications");

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });

  return Notifications;
}

function getTotalStats(stats: FirebaseStats) {
  return Object.values(stats).reduce(
    (total, current) => ({
      success: total.success + current.success,
      failed: total.failed + current.failed,
    }),
    { success: 0, failed: 0 },
  );
}

function addFunctionResult(
  stats: FirebaseStats,
  functionName: FirebaseFunctionName,
  result: FunctionResult,
): FirebaseStats {
  return {
    ...stats,
    [functionName]: {
      success:
        stats[functionName].success + (result.success ? 1 : 0),
      failed: stats[functionName].failed + (result.success ? 0 : 1),
    },
  };
}

function buildNotificationBody(stats: FirebaseStats) {
  const total = getTotalStats(stats);

  return `${total.success} successful, ${total.failed} unsuccessful.`;
}

async function saveStatsToFirestore(stats: FirebaseStats): Promise<FunctionResult> {
  const projectId = Constants?.expoConfig?.extra?.firebase?.projectId;

  if (!projectId) {
    return {
      success: false,
      message: "Project ID not found for Firestore.",
    };
  }

  try {
    const total = getTotalStats(stats);
    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/firebaseStats`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fields: {
            firestoreSuccess: { integerValue: stats.firestore.success },
            firestoreFailed: { integerValue: stats.firestore.failed },
            fcmSuccess: { integerValue: stats.fcm.success },
            fcmFailed: { integerValue: stats.fcm.failed },
            totalSuccess: { integerValue: total.success },
            totalFailed: { integerValue: total.failed },
            createdAt: { timestampValue: new Date().toISOString() },
          },
        }),
      },
    );

    if (!response.ok) {
      return {
        success: false,
        message: `Firestore failed with status ${response.status}.`,
      };
    }

    return { success: true };
  } catch (error: unknown) {
    return {
      success: false,
      message: `${error}`,
    };
  }
}

async function sendPushNotification(
  expoPushToken: string,
  stats: FirebaseStats,
): Promise<FunctionResult> {
  const message = {
    to: expoPushToken,
    sound: "default",
    title: "Firebase functions: Sent data",
    body: buildNotificationBody(stats),
    data: {
      firestore: stats.firestore,
      fcm: stats.fcm,
      total: getTotalStats(stats),
    },
  };

  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    return {
      success: false,
      message: `FCM failed with status ${response.status}.`,
    };
  }

  const result = await response.json();
  const pushTicket = Array.isArray(result?.data) ? result.data[0] : result?.data;

  if (pushTicket?.status === "error") {
    return {
      success: false,
      message: pushTicket?.message ?? "FCM returned an error ticket.",
    };
  }

  return { success: true };
}

function handleRegistrationError(errorMessage: string) {
  alert(errorMessage);
  throw new Error(errorMessage);
}

async function registerForPushNotificationsAsync(
  Notifications: NotificationsModule,
) {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#FF231F7C",
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") {
    handleRegistrationError(
      "Permission not granted to get push token for push notification!",
    );
    return;
  }
  const projectId =
    Constants?.expoConfig?.extra?.eas?.projectId ??
    Constants?.easConfig?.projectId;
  if (!projectId) {
    handleRegistrationError("Project ID not found");
  }
  try {
    const pushTokenString = (
      await Notifications.getExpoPushTokenAsync({
        projectId,
      })
    ).data;
    console.log(pushTokenString);
    return pushTokenString;
  } catch (e: unknown) {
    handleRegistrationError(`${e}`);
  }
}

export default function App() {
  const [expoPushToken, setExpoPushToken] = useState("");
  const [firebaseStats, setFirebaseStats] =
    useState<FirebaseStats>(initialFirebaseStats);
  const [lastResult, setLastResult] = useState("");
  const [notification, setNotification] = useState<
    ExpoNotification | undefined
  >(undefined);

  useEffect(() => {
    let notificationListener: { remove: () => void } | undefined;
    let responseListener: { remove: () => void } | undefined;
    let isMounted = true;

    getNotificationsModule()
      .then((Notifications) => {
        if (!isMounted) {
          return;
        }

        if (!Notifications) {
          setExpoPushToken(
            "Push notifications need a development build on Android. Expo Go no longer supports remote push notifications.",
          );
          return;
        }

        registerForPushNotificationsAsync(Notifications)
          .then((token) => {
            if (isMounted) {
              setExpoPushToken(token ?? "");
            }
          })
          .catch((error: unknown) => {
            if (isMounted) {
              setExpoPushToken(`${error}`);
            }
          });

        notificationListener = Notifications.addNotificationReceivedListener(
          (notification: ExpoNotification) => {
            setNotification(notification);
          },
        );

        responseListener =
          Notifications.addNotificationResponseReceivedListener(
            (response: ExpoNotificationResponse) => {
              console.log(response);
            },
          );
      })
      .catch((error: unknown) => setExpoPushToken(`${error}`));

    return () => {
      isMounted = false;
      notificationListener?.remove();
      responseListener?.remove();
    };
  }, []);

  return (
    <View
      style={{ flex: 1, alignItems: "center", justifyContent: "space-around" }}
    >
      <Text>Your Expo push token: {expoPushToken}</Text>
      <View style={{ alignItems: "center", justifyContent: "center" }}>
        <Text>
          Firestore: {firebaseStats.firestore.success} success,{" "}
          {firebaseStats.firestore.failed} failed
        </Text>
        <Text>
          FCM: {firebaseStats.fcm.success} success, {firebaseStats.fcm.failed}{" "}
          failed
        </Text>
        <Text>Notification body: {buildNotificationBody(firebaseStats)}</Text>
        <Text>{lastResult}</Text>
      </View>
      <View style={{ alignItems: "center", justifyContent: "center" }}>
        <Text>
          Title: {notification && notification.request.content.title}{" "}
        </Text>
        <Text>Body: {notification && notification.request.content.body}</Text>
        <Text>
          Data:{" "}
          {notification && JSON.stringify(notification.request.content.data)}
        </Text>
      </View>
      <Button
        title="Press to Send Notification"
        disabled={!expoPushToken.startsWith("ExponentPushToken")}
        onPress={async () => {
          const firestoreResult = await saveStatsToFirestore(firebaseStats);
          const statsAfterFirestore = addFunctionResult(
            firebaseStats,
            "firestore",
            firestoreResult,
          );
          const statsForNotification = addFunctionResult(
            statsAfterFirestore,
            "fcm",
            { success: true },
          );
          const fcmResult = await sendPushNotification(
            expoPushToken,
            statsForNotification,
          );
          const nextStats = fcmResult.success
            ? statsForNotification
            : addFunctionResult(statsAfterFirestore, "fcm", fcmResult);

          setFirebaseStats(nextStats);
          setLastResult(
            [
              `Firestore: ${firestoreResult.success ? "success" : "failed"}`,
              `FCM: ${fcmResult.success ? "success" : "failed"}`,
              firestoreResult.message,
              fcmResult.message,
            ]
              .filter(Boolean)
              .join(" | "),
          );
        }}
      />
    </View>
  );
}
