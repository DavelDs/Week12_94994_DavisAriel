import { useState, useEffect } from "react";
import { Text, View, Button, Platform } from "react-native";
import Constants from "expo-constants";

type NotificationsModule = typeof import("expo-notifications");
type ExpoNotification = import("expo-notifications").Notification;
type ExpoNotificationResponse =
  import("expo-notifications").NotificationResponse;

const isExpoGoOnAndroid =
  Platform.OS === "android" && Constants.appOwnership === "expo";

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

async function sendPushNotification(expoPushToken: string) {
  const message = {
    to: expoPushToken,
    sound: "default",
    title: "Original Title",
    body: "And here is the body!",
    data: { someData: "goes here" },
  };

  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
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
          await sendPushNotification(expoPushToken);
        }}
      />
    </View>
  );
}
