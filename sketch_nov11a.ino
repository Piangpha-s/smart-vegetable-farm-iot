#include <Wire.h>
#include <BH1750.h>
#include <DHT.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <LiquidCrystal_I2C.h>
#include <ArduinoJson.h>

// ===== Wi-Fi & Server =====
const char* WIFI_SSID = "FiwNo1";
const char* WIFI_PASS = "0993160593";
// เปลี่ยนให้ตรงกับเครื่องที่รัน Flask
const char* SERVER_BASE = "http://172.20.10.12:5000";


bool pumpOn = false;
bool isManualMode = false;
bool fanOn = false; 
bool lightOn = false;

// เกณฑ์ฮิสเทอรีซีสรดน้ำ
float soilOpenPct  = 30.0;   // เปิดน้ำเมื่อ % ต่ำกว่า
float soilClosePct = 46.0;   // ปิดน้ำเมื่อ % สูงกว่า

// ===== Scheduled Water (ESP32 เป็นเจ้าของเวลา) =====
unsigned long waterStartMillis = 0;
unsigned long waterDurationMs = 0;
bool scheduledWaterActive = false;

// ===== Scheduled Fan (ESP32 เป็นเจ้าของเวลา) =====
unsigned long fanStartMillis = 0;
unsigned long fanDurationMs = 0;   // เผื่อใช้ในอนาคต
bool scheduledFanActive = false;

// --- DHT22 ---
#define DHTPIN 4
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

// --- Soil Moisture Sensor ---
#define SOIL_PIN 34

// --- Ultrasonic ---
#define TRIG_PIN 5
#define ECHO_PIN 18

// --- Relay & SSR ---
#define RELAY_PUMP 27
#define RELAY_FAN 26
#define SSR_LIGHT 25

// --- BH1750 (Light Sensor) ---
BH1750 lightMeter;

// --- LCD 20x4 ---
LiquidCrystal_I2C lcd(0x27, 20, 4); // ถ้าไม่ขึ้นให้ลองเปลี่ยนเป็น 0x3F

// --- ค่าควบคุมอัตโนมัติ ---
float tempThreshold = 27.0;

// --- ค่าคาลิเบรตความชื้นดิน (จากที่เราวัดจริง) ---
int soilDry = 2351;   // ดินแห้ง
int soilWet = 1316;   // ดินอิ่มน้ำ

// --- EMA ตัวแปรสำหรับ smoothing ---
float soilEMA = 0;
float distanceEMA = 0;
const float alpha = 0.3;

// ---------- Wi-Fi / HTTP ----------
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("WiFi connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(" OK");
  Serial.print("IP: "); Serial.println(WiFi.localIP());
}

void sendToServer(float temperature,
                  float distanceCm, float lux, float soilPercent) {

  if (WiFi.status() != WL_CONNECTED) return;

  char url[300];
  snprintf(url, sizeof(url),
           "%s/update?temperature=%.2f&distance=%.2f&light=%.0f&soil=%.2f",
           SERVER_BASE, temperature, distanceCm, lux, soilPercent);

  HTTPClient http;
  http.begin(url);

  int code = http.GET();
  if (code > 0) {
    Serial.println("Server response: " + http.getString());
  } else {
    Serial.printf("HTTP GET failed: %d\n", code);
  }
  http.end();
}


void fetchControlCommands(bool &pumpOn, bool &fanOn, bool &lightOn, unsigned long &durationMs) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected, skip fetchControlCommands");
    return;
  }

  HTTPClient http;
  String url = String(SERVER_BASE) + "/get_control";
  Serial.println("Fetching control from: " + url);
  http.begin(url);

  int code = http.GET();
  if (code == 200) {
    String payload = http.getString();
    Serial.println("Control response: " + payload);

    StaticJsonDocument<256> doc;
    DeserializationError error = deserializeJson(doc, payload);
    if (!error) {
      pumpOn  = doc["water"];
      fanOn   = doc["fan"];
      lightOn = doc["light"];
      if (doc.containsKey("duration")) {
        durationMs = (unsigned long)doc["duration"] * 1000UL;
      }

      const char* modeStr = doc["mode"];
      isManualMode = (String(modeStr).equalsIgnoreCase("manual"));
      Serial.printf("Parsed -> water:%d light:%d fan:%d mode:%s\n",
                    pumpOn, lightOn, fanOn, isManualMode ? "manual" : "auto");
    } else {
      Serial.println("JSON parse failed!");
    }
  } else {
    Serial.printf("HTTP GET failed: %d\n", code);
  }
  http.end();
}


float soilPercentFromRaw(int raw) {
  float pct = (float)(soilDry - raw) * 100.0 / (float)(soilDry - soilWet);
  return constrain(pct, 0, 100);
}

void setup() {
  Serial.begin(115200);
  dht.begin();
  Wire.begin();
  lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE);
  lcd.init();
  lcd.backlight();

  pinMode(RELAY_PUMP, OUTPUT);
  pinMode(RELAY_FAN, OUTPUT);
  pinMode(SSR_LIGHT, OUTPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  // ปิดทุกอุปกรณ์ก่อนเริ่ม (Active LOW)
  digitalWrite(RELAY_PUMP, HIGH);
  digitalWrite(RELAY_FAN, HIGH);
  digitalWrite(SSR_LIGHT, LOW);

  lcd.setCursor(0, 0);
  lcd.print(" Auto Water System ");
  lcd.setCursor(0, 1);
  lcd.print(" Initializing...   ");
  delay(2000);
  lcd.clear();

  connectWiFi();

  Serial.println("ระบบเริ่มทำงานแล้ว...");
}

// --- ฟังก์ชันอ่าน Soil Moisture + median ---
int readSoilRaw() {
  const int samples = 10;
  int arr[samples];
  for (int i = 0; i < samples; i++) {
    arr[i] = analogRead(SOIL_PIN);
    delay(5);
  }
  for (int i = 0; i < samples - 1; i++) {
    for (int j = i + 1; j < samples; j++) {
      if (arr[j] < arr[i]) {
        int t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
      }
    }
  }
  return arr[samples / 2];
}

// --- ฟังก์ชันอ่าน Ultrasonic + median ---
float readDistance() {
  const int samples = 5;
  float arr[samples];
  for (int i = 0; i < samples; i++) {
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);
    long duration = pulseIn(ECHO_PIN, HIGH, 30000);
    arr[i] = duration * 0.034 / 2;
    delay(5);
  }
  for (int i = 0; i < samples - 1; i++) {
    for (int j = i + 1; j < samples; j++) {
      if (arr[j] < arr[i]) {
        float t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
      }
    }
  }
  return arr[samples / 2];
}

void loop() {
  // อ่านเซ็นเซอร์
  float temperature = isnan(dht.readTemperature()) ? -127.0 : dht.readTemperature();
  uint16_t lux = lightMeter.readLightLevel();
  if (lux == 65535 || lux == 65534) {
  Serial.println("BH1750 read error!");
  lux = 0; // หรือค่า default
  }
  int soilRaw = readSoilRaw();
  float soilPercent = soilPercentFromRaw(soilRaw);
  soilEMA = alpha * soilPercent + (1 - alpha) * soilEMA;
  float distance = readDistance();
  distanceEMA = alpha * distance + (1 - alpha) * distanceEMA;

  sendToServer(temperature, distance, (float)lux, soilPercent);


  // ===== FETCH COMMAND FROM SERVER =====
  bool cmdPump = pumpOn;
  bool cmdFan  = fanOn;
  bool cmdLight = lightOn;
  unsigned long cmdDurationMs = 0;

  fetchControlCommands(cmdPump, cmdFan, cmdLight, cmdDurationMs);

  // ===== APPLY SERVER COMMANDS (ALWAYS) =====
  pumpOn  = cmdPump;
  fanOn   = cmdFan;
  lightOn = cmdLight;

  // manual → ยกเลิก scheduled
  if (isManualMode) {
    scheduledWaterActive = false;
  }

    // ===== FAN SCHEDULED =====
  if (!isManualMode && cmdFan && !scheduledFanActive) {
    fanOn = true;
    scheduledFanActive = true;
  }

  if (!isManualMode && !cmdFan && scheduledFanActive) {
    fanOn = false;
    scheduledFanActive = false;
  }

    // ===== Scheduled Water handling =====
  if (!isManualMode && cmdPump && cmdDurationMs > 0 && !scheduledWaterActive) {
    pumpOn = true;
    scheduledWaterActive = true;
    waterStartMillis = millis();
    waterDurationMs = cmdDurationMs;

    Serial.printf("🕒 Scheduled water start (%lu ms)\n", waterDurationMs);
  }

    // ===== Scheduled Water STOP =====
  if (scheduledWaterActive) {
    if (millis() - waterStartMillis >= waterDurationMs) {
      pumpOn = false;
      scheduledWaterActive = false;
      waterDurationMs = 0;

      Serial.println("🛑 Scheduled water stop");
    }
  }

  Serial.printf("ManualMode=%s cmdPump=%d cmdFan=%d cmdLight=%d\n",
              isManualMode ? "true":"false", cmdPump, cmdFan, cmdLight);

    static bool lastPump=false, lastFan=false, lastLight=false;

    if (pumpOn != lastPump) { 
      digitalWrite(RELAY_PUMP, pumpOn ? LOW : HIGH); 
      lastPump = pumpOn; 
      sendStatusToServer();
    }

    if (fanOn != lastFan) {   
      digitalWrite(RELAY_FAN, fanOn ? LOW : HIGH);   
      lastFan = fanOn; 
      sendStatusToServer();
    }

    if (lightOn != lastLight) {
      digitalWrite(SSR_LIGHT, lightOn ? HIGH : LOW); 
      lastLight = lightOn; 
      sendStatusToServer();
    }

  // Serial & LCD
  Serial.printf("Soil:%.2f%% RAW=%d EMA=%.2f%%\nTemp:%.2f°C\nLight:%u lux\nWater:%.2f cm EMA=%.2f cm\nPump:%s Fan:%s Light:%s\n\n",
                soilPercent, soilRaw, soilEMA, temperature, lux, distance, distanceEMA,
                pumpOn?"ON":"OFF", fanOn?"ON":"OFF", lightOn?"ON":"OFF");

  lcd.setCursor(0,0); lcd.printf("Soil:%.1f%% Pum:%s", soilEMA, pumpOn?"ON ":"OFF");
  lcd.setCursor(0,1); lcd.printf("Temp:%4.1fC Fan:%s", temperature, fanOn?"ON ":"OFF");
  lcd.setCursor(0,2); lcd.printf("Ligh:%dL Ligh:%s", lux, lightOn?"ON ":"OFF ");
  lcd.setCursor(0,3); lcd.printf("Water:%3dcm M:%s", (int)(distanceEMA+0.5), isManualMode ? "Manual" : "Auto");

  delay(3000);
}


void sendStatusToServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  char url[200];
  snprintf(url, sizeof(url),
    "%s/update_status?water=%d&fan=%d&light=%d",
    SERVER_BASE,
    pumpOn ? 1 : 0,
    fanOn ? 1 : 0,
    lightOn ? 1 : 0
  );

  HTTPClient http;
  http.begin(url);
  http.GET();
  http.end();
}
