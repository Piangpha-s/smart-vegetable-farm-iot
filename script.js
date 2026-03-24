// ข้อมูลจำลองเซนเซอร์
let sensorData = {
    soilMoisture: 68,
    temperature: 15,
    lightLevel: 230,
    waterLevel: 85,
};

// สถานะระบบ
let systemState = {
    mode: 'auto',
    water: false,
    light: false,
    fan: false
};

let lastWateredTime = null;

let activePlantLocked = false;

let lastPostedActivePlant = null;


// ข้อมูลพืชที่แนะนำ
const plantRecommendations = {
    'ผักเรดโอ๊ค': {
        description: 'ผักใบเขียวที่ต้องการการดูแลในสภาพแวดล้อมที่เย็นและชื้น เหมาะสำหรับการปลูกแบบควบคุมสภาพแวดล้อม',
        temp: '7-18°C',
        soil: '60-80%',
        light: '14-16 ชม./วัน'
    }
};


// ===== Live sensor helpers (ADD) =====
const SENSOR_ENDPOINT = "http://172.20.10.12:5000/sensor"; // ← เปลี่ยนเป็นโดเมน/พอร์ตของคุณได้
const POLL_MS = 3000;


// ฟอร์แมตตัวเลข
function fmt(n, d = 1, fallback = "--") {
  if (n === null || n === undefined || isNaN(n)) return fallback;
  return Number(n).toFixed(d);
}

// แปลง lux → PPFD (ประมาณ)
function luxToPPFD(lux) {
  if (lux == null || isNaN(lux)) return null;
  return lux / 54; // ~1 µmol/m²/s ≈ 54 lux (ประมาณ)
}

// แปลงระยะ ultrasonic → % น้ำในถัง (0% = ระยะ ≈ TANK_DEPTH_CM, 100% = ระยะ ≈ 0)
function waterDistanceToPercent(distanceCm) {
  if (distanceCm == null || isNaN(distanceCm) || TANK_DEPTH_CM <= 0) return null;
  let pct = (TANK_DEPTH_CM - distanceCm) / TANK_DEPTH_CM * 100;
  return Math.max(0, Math.min(100, pct));
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}


// store โปรไฟล์พืชแบบ normalize (Option B)
const plantStore = {}; // key = plant.name → {targets, displayRanges, water, light, fan, ...}

// แปลงเอกสารจากเซิร์ฟเวอร์ → โครงสร้าง Option B (รองรับสคีมาเก่าด้วย)
function normalizePlantDoc(p) {
  // targets (ตัวเลขคุมจริง)
  const targets = {
    temperature: toInt(p?.targets?.temperature ?? p?.temperatureTarget ?? p?.temperatureRange),
    soilMoisture: toInt(p?.targets?.soilMoisture ?? p?.soilMoistureTarget ?? p?.soilMoistureRange)
  };

  // displayRanges (สตริงโชว์สวย ๆ)
  const displayRanges = {
    temperature: p?.displayRanges?.temperature ?? p?.temperatureRange ?? "-",
    soilMoisture: p?.displayRanges?.soilMoisture ?? p?.soilMoistureRange ?? "-",
    waterLevel:   p?.displayRanges?.waterLevel ?? "50–70%",
    light:        p?.displayRanges?.light ?? p?.lightDuration ?? "14–16 ชม./วัน"
  };

  // เอาท์พุต 3 ตัว (โครงเดียว)
  const water = {
    mode: p?.water?.mode ?? p?.wateringMode ?? "auto",
    intervalHours: toNullableInt(p?.water?.intervalHours ?? p?.wateringInterval),
    durationMinutes: toNullableInt(p?.water?.durationMinutes ?? p?.wateringDuration)
  };
  const light = {
    mode: p?.light?.mode ?? p?.lightMode ?? "auto",
    intervalHours: toNullableInt(p?.light?.intervalHours ?? p?.lightInterval),
    durationMinutes: toNullableInt(p?.light?.durationMinutes ?? p?.lightDurationMinutes)
  };
  const fan = {
    mode: p?.fan?.mode ?? p?.fanMode ?? "auto",
    intervalHours: toNullableInt(p?.fan?.intervalHours ?? p?.fanInterval),
    durationMinutes: toNullableInt(p?.fan?.durationMinutes ?? p?.fanDuration)
  };

  return {
    name: p?.name ?? "Unnamed",
    description: p?.description ?? "",
    targets, displayRanges, water, light, fan,
    // เก็บของเก่า/อื่น ๆ เผื่อใช้งาน
    lightOnTime: p?.lightOnTime ?? "06:00",
    lightOffTime: p?.lightOffTime ?? "20:00",
    fanOnTime: p?.fanOnTime ?? "06:00",
    fanOffTime: p?.fanOffTime ?? "20:00",
    growthStage: p?.growthStage ?? "vegetative"
  };
}

function toInt(v, d = 0) {
  if (v == null) return d;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  const m = String(v).match(/-?\d+/);
  return m ? parseInt(m[0], 10) : d;
}
function toNullableInt(v) {
  if (v == null || v === "") return null;
  return toInt(v);
}


function updatePlantDisplay() {
  const selector = document.getElementById('displayPlantSelector');
  if (!selector) return;

  const selectedPlant = selector.value;
  const plant = plantRecommendations[selectedPlant];
  if (!plant) return;
  
  console.log("📘 คำอธิบายของพืชที่เลือก:", plant.description);

  // ✅ ตั้งค่า originalPlantName
  const originalInput = document.getElementById("originalPlantName");
  if (originalInput) originalInput.value = selectedPlant;

  // ✅ ตั้งค่าชื่อพืช
  document.getElementById("plantTypeName").value = selectedPlant;

  // 🧩 แยกช่วงอุณหภูมิ
  const [tempMin, tempMax] = (plant.temperatureRange || "").replace("°C", "").split("–").map(v => v.trim());
  document.getElementById("targetTemperatureMin").value = tempMin || "";
  document.getElementById("targetTemperatureMax").value = tempMax || "";

  // 🧩 แยกช่วงความชื้นในดิน
  const [soilMin, soilMax] = (plant.soilMoistureRange || "").replace("%", "").split("–").map(v => v.trim());
  document.getElementById("targetSoilMoistureMin").value = soilMin || "";
  document.getElementById("targetSoilMoistureMax").value = soilMax || "";

  // 🧩 แยกช่วงระยะเวลาแสง
  const lightRaw = (plant.lightDuration || "").replace("ชม./วัน", "").trim();
  const [lightMin, lightMax] = lightRaw.split("–").map(v => v.trim());
  document.getElementById("lightDurationMin").value = lightMin || "";
  document.getElementById("lightDurationMax").value = lightMax || "";

  // ⏰ เวลาต่าง ๆ
  document.getElementById("lightOnTime").value  = plant.lightOnTime  || "06:00";
  document.getElementById("lightOffTime").value = plant.lightOffTime || "20:00";
  document.getElementById("waterOnTime").value  = plant.waterOnTime  || "08:20";
  document.getElementById("waterOffTime").value = plant.waterOffTime || "08:22";
  document.getElementById("growthStage").value = plant.growthStage || "seedling";

  // ⭐ ตั้งค่าโหมดรายอุปกรณ์
  const wSel = document.getElementById("wateringMode");
  const lSel = document.getElementById("lightMode");
  const fSel = document.getElementById("fanMode");
  if (wSel) wSel.value = plant.wateringMode || "auto";
  if (lSel) lSel.value = plant.lightMode || "auto";
  if (fSel) fSel.value = plant.fanMode || "auto";

  // ⭐ เวลาเปิด/ปิดพัดลม
  const fanOnEl  = document.getElementById("fanOnTime");
  const fanOffEl = document.getElementById("fanOffTime");
  if (fanOnEl)  fanOnEl.value  = plant.fanOnTime  || "06:00";
  if (fanOffEl) fanOffEl.value = plant.fanOffTime || "20:00";

  // ✅ อัปเดตข้อมูลแสดงผลในกล่องข้อมูลพืช
  const nameEl = document.getElementById('plantName');
  const descEl = document.getElementById('plantDescription');
  const tempEl = document.getElementById('temperatureRange');
  const soilEl = document.getElementById('soilRange');
  const lightEl = document.getElementById('lightRange');

  if (nameEl) nameEl.textContent = selectedPlant;
  if (descEl) descEl.textContent = plant.description || "";
  if (tempEl) tempEl.textContent = plant.temperatureRange || "-";
  if (soilEl) soilEl.textContent = plant.soilMoistureRange || "-";
  if (lightEl) lightEl.textContent = plant.lightDuration || "-";

  // ให้การซ่อน/แสดงช่องต่าง ๆ ตรงกับโหมดล่าสุด
  if (typeof updateModeVisibility === 'function') {
    updateModeVisibility();
  }

}



// กราฟแสดงข้อมูล
let chart;
let chartData = {
    labels: [],
    datasets: [
        {
            label: 'ความชื้นในดิน (%)',
            data: [],
            borderColor: 'rgb(54, 162, 235)',
            backgroundColor: 'rgba(54, 162, 235, 0.1)',
            tension: 0.4
        },
        {
            label: 'อุณหภูมิ (°C)',
            data: [],
            borderColor: 'rgb(255, 99, 132)',
            backgroundColor: 'rgba(255, 99, 132, 0.1)',
            tension: 0.4
        }
    ]
};


function initChart() {
    const ctx = document.getElementById('sensorChart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'line',
        data: chartData,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top'
                }
            }
        }
    });
}


function updateControl(type, state, { bypassAuto = false, silent = false } = {}) {
  // ⚠️ MANUAL INTENT ONLY
  // This function represents USER ACTION
  // It must NOT:
  // - decide auto behavior
  // - override server decision
  // - contain sensor-based logic

  // บล็อกคำสั่งจากผู้ใช้เมื่ออยู่โหมดอัตโนมัติ (เว้นแต่เป็นคำสั่งจากระบบออโต้)
  if (systemState.mode === 'auto' && !bypassAuto) {
    if (!silent) showAlert('❌ ไม่สามารถควบคุมได้ในโหมดอัตโนมัติ', 'warning');
    return;
  }

  // ✅ ส่งคำสั่งไปยัง Flask Server พร้อมโหมดปัจจุบัน
  fetch('http://172.20.10.12:5000/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      [type]: state ? 1 : 0,
      mode: systemState.mode   // ส่งโหมดไปด้วย
    })
  })
  .then(res => res.json())
  .then(data => {
    console.log('อัปเดตการควบคุมสำเร็จ:', data);
    if (!silent) {
      showAlert(
        `✅ ${type === 'water' ? 'น้ำ' : type === 'light' ? 'ไฟ' : 'พัดลม'} ${state ? 'เปิด' : 'ปิด'} แล้ว`,
        'success'
      );
    }
  })
  .catch(err => {
    console.error('❌ ส่งคำสั่งล้มเหลว:', err);
    if (!silent) showAlert('❌ ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้', 'warning');
  });
}



function setPlantTypeName(plantName) {
    document.getElementById('plantTypeName').value = plantName; }


function loadPlantSettings() {
    const selected = document.getElementById("plantType").value;

    if (selected === "custom") {
        const newPlant = prompt("🌿 กรุณากรอกชื่อพืชใหม่:");

        if (newPlant && newPlant.trim() !== "") {
            const newName = newPlant.trim();
            const newValue = newName.toLowerCase().replace(/\s+/g, "_");

            const displaySelector = document.getElementById("displayPlantSelector");
            const plantTypeSelector = document.getElementById("plantType");

            let duplicate = false;
            for (let option of displaySelector.options) {
                if (option.value === newValue || option.textContent === newName) {
                    duplicate = true;
                    break;
                }
            }
            for (let option of plantTypeSelector.options) {
                if (option.value === newValue || option.textContent === newName) {
                    duplicate = true;
                    break;
                }
            }
            if (plantRecommendations[newName]) {
                duplicate = true;
            }

            if (duplicate) {
                showAlert(`⚠️ "${newName}" มีอยู่ในระบบแล้ว`, "warning");
                return;
            }

            // ✅ เพิ่มใน dropdown ทั้งสอง
            const option1 = document.createElement("option");
            option1.value = newValue;
            option1.textContent = newName;
            displaySelector.appendChild(option1);

            const option2 = document.createElement("option");
            option2.value = newValue;
            option2.textContent = newName;
            plantTypeSelector.appendChild(option2);

            // ✅ เพิ่มในฐานข้อมูลภายใน
            plantRecommendations[newName] = {
                description: `พืชชนิดใหม่ที่คุณเพิ่ม (${newName})`,
                temp: "20-30°C",
                soil: "60-80%",
                light: "12-16 ชม./วัน"
            };

            const plantNameInput = document.getElementById("plantTypeName");
            if (plantNameInput) plantNameInput.value = newName;

            displaySelector.value = newValue;

            showAlert(`🌱 เพิ่ม "${newName}" เรียบร้อยแล้ว`, "success");

            // ✅ ส่งข้อมูลพืชใหม่ไปบันทึกใน MongoDB
            fetch('http://172.20.10.12:5000/plants', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newName,
                    temperatureRange: "20-30°C",
                    soilMoistureRange: "60-80%",
                    lightDuration: "12-16 ชม./วัน",
                })
            })
            .then(res => {
                if (!res.ok) {
                    showAlert(`⚠️ "${newName}" มีอยู่ในระบบแล้ว`, "warning");
                    return;
                }
                showAlert(`🌱 "${newName}" ถูกบันทึกในฐานข้อมูลเรียบร้อยแล้ว`, "success");
            })
            .catch(err => {
                console.error("❌ บันทึกพืชไม่สำเร็จ:", err);
                showAlert("❌ ไม่สามารถเชื่อมต่อฐานข้อมูลได้", "warning");
            });

        } else {
            showAlert("❌ กรุณากรอกชื่อพืชก่อนเพิ่ม", "warning");
        }
    }
}


// คืนสถานะแสง (ตัวหนังสือ)
function getLightStatus(ppfd) {
  if (ppfd < 100) {
    return '<span class="light-status">🌑 มืดมาก</span>';
  } else if (ppfd < 400) {
    return '<span class="light-status">🌥️ แสงน้อย</span>';
  } else if (ppfd < 1000) {
    return '<span class="light-status">🌤️ แสงพอเหมาะ</span>';
  } else {
    return '<span class="light-status">☀️ แสงแรง</span>';
  }
}


function fetchSensorData() {
  fetch('http://172.20.10.12:5000/data')
    .then(response => response.json())
    .then(data => {
      // ===== อัปเดตค่าจาก ESP32 =====
      if (data.temperature !== undefined) {
        sensorData.temperature = data.temperature;
      }
      if (data.soilMoisture !== undefined) {
        sensorData.soilMoisture = data.soilMoisture;
      }
      if (data.light !== undefined) {
        sensorData.lightLevel = data.light;
      }

      // ===== คำนวณระดับน้ำจาก distance (cm) → % ตามถังจริงของคุณ =====
      if (data.distance !== undefined) {
        const fullDistance  = 5.93;  // ระยะตอนน้ำเต็ม (cm)
        const emptyDistance = 24.43; // ระยะตอนน้ำหมด (cm)

        let waterPercent = (emptyDistance - data.distance) /
                           (emptyDistance - fullDistance) * 100;

        sensorData.waterLevel = Math.max(0, Math.min(100, waterPercent));

        // แสดงระยะจริง (cm) เพิ่มในเว็บ (ตัวหนังสือตัวเล็กใต้ % น้ำ)
        const distEl = document.getElementById('distanceValue');
        if (distEl) {
          distEl.textContent = `ระยะจากผิวน้ำ: ${data.distance.toFixed(1)} ซม.`;
        }
      }

      // ===== แสดงผลบนหน้าเว็บ (กล่อง 📊 ข้อมูลเซนเซอร์) =====
      document.getElementById('soilMoisture').textContent =
        Math.round(sensorData.soilMoisture) + '%';

      document.getElementById('temperature').textContent =
        sensorData.temperature.toFixed(1) + '°C';
        
      // ===== อัปเดต "ปัจจุบัน" ใน Optimal Range =====
      const tempNowEl = document.getElementById('temperatureNow');
      if (tempNowEl) {
        tempNowEl.textContent = 
          data.temperature !== undefined ? data.temperature.toFixed(1) + "°C" : "-";
      }

      const soilNowEl = document.getElementById('soilNow');
      if (soilNowEl) {
        soilNowEl.textContent =
          sensorData.soilMoisture !== undefined ? Math.round(sensorData.soilMoisture) + "%" : "-";
      }


      // --- ส่วนของแสง: แสดงทั้งค่า + สถานะข้อความ ---
      const lightLevelEl = document.getElementById('lightLevel');
      const lightNowEl   = document.getElementById('lightNow');  // ถ้ามีช่องนี้ในหน้าเว็บ

      if (sensorData.lightLevel != null && !isNaN(sensorData.lightLevel)) {
        const lux  = sensorData.lightLevel;     // ค่าที่ ESP32 ส่งมา (lux)
        const ppfd = luxToPPFD(lux);           // แปลงเป็น µmol/m²/s ประมาณๆ
        const statusHtml = getLightStatus(ppfd); // 🌑 / 🌥️ / 🌤️ / ☀️

        if (lightLevelEl) {
          lightLevelEl.innerHTML =
            `${fmt(ppfd,0)} µmol/m²/s ${statusHtml}`;
        }

        if (lightNowEl) {
          lightNowEl.innerHTML =
            `${fmt(ppfd,0)} µmol/m²/s ${statusHtml}`;
        }
      } else {
        if (lightLevelEl) lightLevelEl.textContent = '0 µmol/m²/s';
        if (lightNowEl)   lightNowEl.textContent   = '-';
      }

      document.getElementById('waterLevel').textContent =
        Math.round(sensorData.waterLevel) + '%';

        // อัปเดต “ระดับน้ำในถัง (ปัจจุบัน: x%)”
      const waterNowEl = document.getElementById('waterLevelNow');
      if (waterNowEl) {
          waterNowEl.textContent = Math.round(sensorData.waterLevel) + '%';
      }

      /*
      // ===== ระบบอัตโนมัติ เมื่ออยู่โหมด auto =====
      if (systemState.mode === 'auto') {
        autoControlSystem();      // ตามค่าเป้า
        scheduledControlSystem(); // ตามช่วงเวลา (น้ำ)
      }
      */
      updateChart();
    })
    .catch(error => {
      console.error('❌ ไม่สามารถดึงข้อมูลเซนเซอร์:', error);
    });
}



function handleModeChange() {
  const mode = document.getElementById("modeSelector").value;

  if (mode === "view") {
    updatePlantDisplay();
    disableForm(true);

    } else if (mode === "edit") {
      const selected = document.getElementById("displayPlantSelector").value;
      const plant = plantRecommendations[selected];
      if (plant) {
        const originalInput = document.getElementById("originalPlantName");
        if (originalInput) originalInput.value = selected;

        document.getElementById("plantTypeName").value = selected;
        // แยก soil range
        const [soilMin, soilMax] = (plant.soilMoistureRange || "")
          .replace("%","")
          .split("–")
          .map(v => v.trim());

        document.getElementById("targetSoilMoistureMin").value = soilMin || "";
        document.getElementById("targetSoilMoistureMax").value = soilMax || "";

        // แยก temperature range
        const [tempMin, tempMax] = (plant.temperatureRange || "")
          .replace("°C","")
          .split("–")
          .map(v => v.trim());

        document.getElementById("targetTemperatureMin").value = tempMin || "";
        document.getElementById("targetTemperatureMax").value = tempMax || "";

        // แยก light duration
        const lightRaw = (plant.lightDuration || "").replace("ชม./วัน","").trim();
        const [lightMin, lightMax] = lightRaw.split("–").map(v => v.trim());

        document.getElementById("lightDurationMin").value = lightMin || "";
        document.getElementById("lightDurationMax").value = lightMax || "";
        document.getElementById("lightOnTime").value = plant.lightOnTime || "06:00";
        document.getElementById("lightOffTime").value = plant.lightOffTime || "20:00";
        document.getElementById("waterOnTime").value  = plant.waterOnTime  || "08:20";
        document.getElementById("waterOffTime").value = plant.waterOffTime || "08:22";
        document.getElementById("growthStage").value = plant.growthStage || "seedling";
        document.getElementById("wateringMode").value = plant.wateringMode || "auto";
        document.getElementById("lightMode").value = plant.lightMode || "auto";
        document.getElementById("fanMode").value   = plant.fanMode   || "auto";
        document.getElementById("fanOnTime").value  = plant.fanOnTime  || "06:00";
        document.getElementById("fanOffTime").value = plant.fanOffTime || "20:00";

        updateModeVisibility(); // ✅ เรียกหลังตั้งค่า dropdown
        }

      } else if (mode === "add") {
        document.getElementById("plantTypeName").value = "";
        document.getElementById("targetSoilMoisture").value = "";
        document.getElementById("targetTemperature").value = "";
        document.getElementById("lightDuration").value = "";
        document.getElementById("lightOnTime").value = "06:00";
        document.getElementById("lightOffTime").value = "20:00";
        document.getElementById("growthStage").value = "seedling";
        document.getElementById("waterOnTime").value  = "08:20";
        document.getElementById("waterOffTime").value = "08:22";
        document.getElementById("wateringMode").value = "auto"; 
        
        updateModeVisibility();
        }

        disableForm(false);
}


// ฟังก์ชันเปลี่ยนโหมดระบบหลัก (auto/manual)
function setMode(mode) {
  // อัปเดตสถานะบน UI (intent)
  const status = document.getElementById('modeStatus');
  status.textContent = mode === 'auto' ? 'โหมดอัตโนมัติ' : 'โหมดแมนนวล';
  status.className = mode === 'auto'
    ? 'status-indicator auto'
    : 'status-indicator manual';

  systemState.mode = mode;

  // ล็อก/ปลดล็อกปุ่มควบคุม
  const controls = document.querySelectorAll('#waterPump, #lightSystem, #fanSystem');
  controls.forEach(c => c.disabled = (mode !== 'manual'));

  // แจ้งโหมดไปยังเซิร์ฟเวอร์
  fetch('http://172.20.10.12:5000/system_mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode })
  })
  .then(() => {
    // ⭐ ดึง "ความจริง" จาก server กลับมา
    fetchControlFromServer();
  })
  .catch(() => {});
}


// ฟังก์ชันจัดการการล็อก/ปลดล็อกของโหมดรายเอาท์พุต
function updateEditLockState() {
  const modeSelector = document.getElementById('modeSelector');
  const perOutputModeSelects = ['wateringMode','lightMode','fanMode']
    .map(id => document.getElementById(id))
    .filter(Boolean);

  // ✅ ปลดล็อกเฉพาะเมื่อ modeSelector = edit
  const editable = (modeSelector.value === 'edit');
  perOutputModeSelects.forEach(sel => sel.disabled = !editable);
}



function updateModeVisibility() {
  // ---- LIGHT ----
  const lightMode   = document.getElementById('lightMode')?.value;
  const lightOnWrap = document.getElementById('lightOnTime')?.closest('.setting-item') 
                   || document.getElementById('lightOnTime')?.parentElement;
  const lightOffWrap = document.getElementById('lightOffTime')?.closest('.setting-item') 
                   || document.getElementById('lightOffTime')?.parentElement;
  if (lightOnWrap && lightOffWrap) {
    const show = (lightMode === 'scheduled');     // แสดงเฉพาะตอน scheduled
    lightOnWrap.style.display  = show ? '' : 'none';
    lightOffWrap.style.display = show ? '' : 'none';
  }

  // ---- FAN ----
  const fanMode   = document.getElementById('fanMode')?.value;
  const fanOnWrap = document.getElementById('fanOnTime')?.closest('.setting-item') 
                 || document.getElementById('fanOnTime')?.parentElement;
  const fanOffWrap = document.getElementById('fanOffTime')?.closest('.setting-item') 
                 || document.getElementById('fanOffTime')?.parentElement;
  if (fanOnWrap && fanOffWrap) {
    const show = (fanMode === 'scheduled');       // แสดงเฉพาะตอน scheduled
    fanOnWrap.style.display  = show ? '' : 'none';
    fanOffWrap.style.display = show ? '' : 'none';
  }

  // ---- WATER ----
  const wateringMode = document.getElementById('wateringMode')?.value;

  const waterOnWrap  = document.getElementById('waterOnTime')?.closest('.setting-item');
  const waterOffWrap = document.getElementById('waterOffTime')?.closest('.setting-item');

  const showWaterTime = (wateringMode === 'scheduled');

  if (waterOnWrap)  waterOnWrap.style.display  = showWaterTime ? '' : 'none';
  if (waterOffWrap) waterOffWrap.style.display = showWaterTime ? '' : 'none';

}

document.addEventListener("DOMContentLoaded", () => {
  ["wateringMode", "lightMode", "fanMode"].forEach(id => {
    document.getElementById(id)?.addEventListener("change", updateModeVisibility);
  });
  
    // ⭐ Step B: ผูก event ให้ dropdown แบบ explicit
  const displaySelect = document.getElementById("displayPlantSelector");
  if (displaySelect) {
    displaySelect.addEventListener("change", () => {
      const plantName = displaySelect.value;

      // guard
      if (!plantName || plantName === "custom") return;

      console.log("🌱 user selected plant:", plantName);

      // อัปเดต UI
      updatePlantDisplay();

      // แจ้ง server เฉพาะตอน user เปลี่ยนจริง
      fetch("http://172.20.10.12:5000/active_plant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plantName })
      }).catch(err =>
        console.warn("⚠️ update active plant failed:", err)
      );
    });
  }
    document.getElementById('waterPump')?.addEventListener('change', e => {
    if (systemState.mode !== 'manual') return;
    updateControl('water', e.target.checked);
  });

  document.getElementById('lightSystem')?.addEventListener('change', e => {
    if (systemState.mode !== 'manual') return;
    updateControl('light', e.target.checked);
  });

  document.getElementById('fanSystem')?.addEventListener('change', e => {
    if (systemState.mode !== 'manual') return;
    updateControl('fan', e.target.checked);
  });

  loadActivePlant();

    // ⭐ heartbeat ของระบบอัตโนมัติ (สำคัญมาก)
  setInterval(() => {
    autoControlSystem();
  }, 60 * 1000);

});

async function loadActivePlant() {
  console.log("🔥 loadActivePlant CALLED"); 
  try {
    const res = await fetch('http://172.20.10.12:5000/active_plant');
    const data = await res.json();

    const selector = document.getElementById('displayPlantSelector');
    if (!selector || !data.plantName) return;

    console.log("🌱 active plant from server:", data.plantName);

    // ⭐ server เป็นคนตัดสิน
    selector.value = data.plantName;

    // ⭐ render UI อย่างเดียว
    updatePlantDisplay();

  } catch (err) {
    console.error("❌ loadActivePlant failed:", err);
  }
}


function autoControlSystem() {
  if (systemState.mode !== 'auto') return;

  const soil = sensorData.soilMoisture;
  const temp = sensorData.temperature;

  const currentHour = new Date().getHours();

  const wateringMode = document.getElementById("wateringMode").value;
  const lightMode    = document.getElementById("lightMode").value;
  const fanMode      = document.getElementById("fanMode").value;

  const soilMinEl = document.getElementById('targetSoilMoistureMin');
  const soilMaxEl = document.getElementById('targetSoilMoistureMax');
  const tempMinEl = document.getElementById('targetTemperatureMin');
  const tempMaxEl = document.getElementById('targetTemperatureMax');

  const soilMin = soilMinEl ? parseInt(soilMinEl.value) : 0;
  const soilMax = soilMaxEl ? parseInt(soilMaxEl.value) : 100;
  const tempMin = tempMinEl ? parseInt(tempMinEl.value) : 0;
  const tempMax = tempMaxEl ? parseInt(tempMaxEl.value) : 100;

  const lightOnHour  = parseInt(document.getElementById('lightOnTime').value.split(':')[0]);
  const lightOffHour = parseInt(document.getElementById('lightOffTime').value.split(':')[0]);

  const fanOnHour  = parseInt(document.getElementById('fanOnTime').value.split(':')[0]);
  const fanOffHour = parseInt(document.getElementById('fanOffTime').value.split(':')[0]);

  // ====================== 💧 WATER ======================
  /*
  WATER CONTROL NOTE:
  - Watering is event-based and critical.
  - All decisions are made by backend.
  - Frontend only reflects server state.
  */

  // ⚠️ legacy helper — do not use in production
  if (wateringMode === "auto") {
    // 🔓 auto = ใช้ sensor soil moisture
    if (soil < soilMin && !systemState.water) {
      updateControl('water', true, { bypassAuto: true, silent: true });
    }
    else if (soil > soilMax && systemState.water) {
      updateControl('water', false, { bypassAuto: true, silent: true });
    }
  }
  

  // ====================== 💡 LIGHT ======================
  if (lightMode === "scheduled") {
    const shouldLightOn = currentHour >= lightOnHour && currentHour < lightOffHour;

    if (shouldLightOn !== systemState.light) {
      updateControl('light', shouldLightOn, { bypassAuto: true, silent: true });
    }
  }
  else  {
    // 🔒 intentionally empty for now
    // sensor-based light control will be added later
  }


  // ====================== 🌪 FAN ======================
  if (fanMode === "scheduled") {
    const shouldFanOn = currentHour >= fanOnHour && currentHour < fanOffHour;

    if (shouldFanOn !== systemState.fan) {
      updateControl('fan', shouldFanOn, { bypassAuto: true, silent: true });
    }
  } 
  else if (fanMode === "auto") {
    if (temp > tempMax && !systemState.fan) {
      updateControl('fan', true, { bypassAuto: true, silent: true });
    } 
    else if (temp < tempMin && systemState.fan) {
      updateControl('fan', false, { bypassAuto: true, silent: true });
    }
  }
}



/*function scheduledControlSystem() {
  const mode = document.getElementById("wateringMode").value;
  if (mode !== "scheduled") return;

  const now = new Date();
  const lastTimeStr = localStorage.getItem("lastWateredTime");
  const lastTime = lastTimeStr ? new Date(lastTimeStr) : null;
  // 🔧 TEST ONLY
  // 1 = นาที (ใช้ทดสอบ)
  // 60 = ชั่วโมงจริง (ใช้ตอนใช้งานจริง)
  const TEST_MULTIPLIER = 1;
  const intervalHours = parseInt(document.getElementById("wateringInterval").value);
  const intervalMs = intervalHours * 60 * 1000 * TEST_MULTIPLIER;

  if (!lastTime || (now - lastTime) >= intervalMs) {

    document.getElementById('waterPump').checked = true;
    updateControl('water', true, { bypassAuto: true, silent: true });
    showAlert(`🕒 ให้น้ำตามช่วงเวลา (${intervalHours} ชม.)`, 'success');
    lastWateredTime = now;

    localStorage.setItem("lastWateredTime", now.toISOString());

      fetch('http://172.20.10.12:5000/log_watering', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plantName: document.getElementById("plantTypeName").value })
      })
        .then(res => res.json())
        .then(data => console.log("📝 บันทึกการรดน้ำ:", data))
        .catch(err => console.error("❌ บันทึกการรดน้ำล้มเหลว:", err));

    // ปิดน้ำหลัง wateringDuration นาที
    const duration = parseInt(document.getElementById("wateringDuration").value);
    setTimeout(() => {
      document.getElementById('waterPump').checked = false;
      updateControl('water', false, { bypassAuto: true, silent: true });
      showAlert('✅ ปิดปั๊มน้ำหลังรดน้ำครบเวลา', 'info');
    }, duration * 60 * 1000);
  }
}
*/

function updateChart() {
    const now = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    
    chartData.labels.push(now);
    chartData.datasets[0].data.push(sensorData.soilMoisture);
    chartData.datasets[1].data.push(sensorData.temperature);

    if (chartData.labels.length > 20) {
        chartData.labels.shift();
        chartData.datasets.forEach(dataset => dataset.data.shift());
    }

    chart.update();
}

function updateModeBadge(mode) {
  const badge = document.getElementById("controlModeBadge");
  if (!badge || !mode) return;

  badge.className = "badge " + mode;
  badge.textContent = mode.toUpperCase();
}

async function fetchControlFromServer() {
  try {
    const res = await fetch('http://172.20.10.12:5000/get_control');
    const data = await res.json();

    // ⭐ แสดงโหมดจาก server (AUTO / MANUAL / SCHEDULED)
    if (data.mode) {
      updateModeBadge(data.mode);
    }

    // water
    document.getElementById('waterPump').checked = !!data.water;
    document.getElementById('waterStatus').textContent = data.water ? 'เปิด' : 'ปิด';

    // light
    document.getElementById('lightSystem').checked = !!data.light;
    document.getElementById('lightStatus').textContent = data.light ? 'เปิด' : 'ปิด';

    // fan
    document.getElementById('fanSystem').checked = !!data.fan;
    document.getElementById('fanStatus').textContent = data.fan ? 'เปิด' : 'ปิด';

  } catch (err) {
    console.error('❌ fetchControlFromServer failed:', err);
  }
}



async function loadPlantsFromServer(selectedName = null, { render = true } = {}) {
  try {
    const res = await fetch('http://172.20.10.12:5000/plants');
    const plants = await res.json();

    const displaySelect = document.getElementById('displayPlantSelector');
    if (!displaySelect) return false;

    // ล้าง options เดิม
    displaySelect.textContent = '';

    // เติมรายชื่อพืช + อัปเดตแหล่งข้อมูล
    plants.forEach(p => {
      const option = document.createElement('option');
      option.value = p.name;
      option.textContent = p.name;
      displaySelect.appendChild(option);

      // เก็บข้อมูลที่หน้าเว็บใช้ (สคีมาเดิมที่คุณมีอยู่)
      plantRecommendations[p.name] = {
        description: p.description ?? "",
        temperatureRange: p.temperatureRange ?? "-",
        soilMoistureRange: p.soilMoistureRange ?? "-",

        lightDuration: p.lightDuration ?? "-",
        lightOnTime: p.lightOnTime ?? "06:00",
        lightOffTime: p.lightOffTime ?? "20:00",
        lightMode: p.lightMode ?? "auto",

        fanOnTime: p.fanOnTime ?? "06:00",
        fanOffTime: p.fanOffTime ?? "20:00",
        fanMode: p.fanMode ?? "auto",

        waterOnTime:  p.waterOnTime  ?? "08:20",
        waterOffTime: p.waterOffTime ?? "08:22",
        wateringMode: p.wateringMode ?? "auto",        
        
        growthStage: p.growthStage ?? "vegetative"
        
      };
    });

    // เติมตัวเลือกเพิ่มชนิดพืช
    const customOption = document.createElement('option');
    customOption.value = 'custom';
    customOption.textContent = '➕ เพิ่มชนิดพืช';
    displaySelect.appendChild(customOption);

    // เลือกค่าใน dropdown
    if (selectedName && plants.some(p => p.name === selectedName)) {
      displaySelect.value = selectedName;
    }

    // เลือกได้ว่าจะ render ตอนนี้เลยไหม
    if (render) updatePlantDisplay();

    console.log("✅ โหลดรายชื่อพืชจาก MongoDB สำเร็จ");
    return true;
  } catch (err) {
    console.error("❌ โหลดรายชื่อพืชจากเซิร์ฟเวอร์ล้มเหลว:", err);
    showAlert("❌ โหลดข้อมูลพืชไม่สำเร็จ", "warning");
    return false;
  }
}

async function saveSettings() {
  const mode = document.getElementById('modeSelector').value;
  const plantName = document.getElementById('plantTypeName').value.trim();
  const growthStage = document.getElementById('growthStage').value;
  const originalName = document.getElementById('originalPlantName')?.value || plantName;

  if (!plantName) {
    showAlert('❌ กรุณาใส่ชื่อพืช', 'warning');
    return;
  }

  const settings = {
    name: plantName,
    growthStage: growthStage,
    temperatureRange: `${document.getElementById('targetTemperatureMin').value}–${document.getElementById('targetTemperatureMax').value}°C`,
    soilMoistureRange: `${document.getElementById('targetSoilMoistureMin').value}–${document.getElementById('targetSoilMoistureMax').value}%`,
    lightDuration: `${document.getElementById('lightDurationMin').value}–${document.getElementById('lightDurationMax').value} ชม./วัน`,
    lightOnTime: document.getElementById('lightOnTime').value,
    lightOffTime: document.getElementById('lightOffTime').value,
    waterOnTime:  document.getElementById('waterOnTime').value,
    waterOffTime: document.getElementById('waterOffTime').value,
    wateringMode: document.getElementById('wateringMode').value,
    lightMode: document.getElementById("lightMode").value,
    fanMode:   document.getElementById("fanMode").value,
    fanOnTime:  document.getElementById('fanOnTime').value,
    fanOffTime: document.getElementById('fanOffTime').value
      };


  console.log("📦 ข้อมูลที่กำลังจะส่ง:", settings);

  if (mode === "add") {
    try {
      const res = await fetch('http://172.20.10.12:5000/plants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      console.log("📥 ตอบกลับจากเซิร์ฟเวอร์:", data);

      if (res.status === 201) {
        showAlert(`🌱 "${plantName}" ถูกเพิ่มเรียบร้อยแล้ว`, "success");
        const success = await loadPlantsFromServer(plantName, { render: true });
      } else {
        showAlert(`⚠️ ไม่สามารถเพิ่ม "${plantName}" ได้: ${data.message}`, "warning");
      }
    } catch (err) {
      console.error("❌ บันทึกพืชไม่สำเร็จ:", err);
      showAlert("❌ ไม่สามารถเชื่อมต่อฐานข้อมูลได้", "warning");
    }

  } else if (mode === "edit") {
    try {
      const res = await fetch(`http://172.20.10.12:5000/plants/${originalName}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      console.log("✏️ ตอบกลับจากเซิร์ฟเวอร์:", data);

      if (res.status === 200) {
        showAlert(`✏️ "${plantName}" ถูกแก้ไขเรียบร้อยแล้ว`, "success");

        document.getElementById("originalPlantName").value = plantName;

        const displaySelect = document.getElementById('displayPlantSelector');
        let found = false;
        for (let option of displaySelect.options) {
          if (option.value === originalName) {
            option.value = plantName;
            option.textContent = plantName;
            found = true;
            break;
          }
        }

        if (!found) {
          const newOption = document.createElement("option");
          newOption.value = plantName;
          newOption.textContent = plantName;
          displaySelect.appendChild(newOption);
        }

        displaySelect.value = plantName;

        const success = await loadPlantsFromServer(plantName, { render: false });
      } else {
        showAlert(`⚠️ ไม่สามารถแก้ไข "${originalName}" ได้: ${data.message}`, "warning");
      }
    } catch (err) {
      console.error("❌ แก้ไขพืชไม่สำเร็จ:", err);
      showAlert("❌ ไม่สามารถเชื่อมต่อฐานข้อมูลได้", "warning");
    }

  } else {
    showAlert(`✅ บันทึกการตั้งค่าสำหรับ "${plantName}" เรียบร้อยแล้ว`, 'success');
  }
}

function disableForm(disabled) {
  const inputs = document.querySelectorAll(
    '#plantTypeName, #targetSoilMoisture, #targetTemperature, #lightDuration, #lightOnTime, #lightOffTime, #waterOnTime, #waterOffTime, #growthStage, #wateringMode'
  );

  inputs.forEach(input => {
    input.disabled = disabled;
  });
}


function showAlert(message, type) {
    const alertContainer = document.getElementById('alertContainer');
    const alert = document.createElement('div');
    alert.className = `alert ${type}`;
    alert.textContent = message;
    
    alertContainer.appendChild(alert);
    
    setTimeout(() => {
        if (alert.parentNode) {
            alert.parentNode.removeChild(alert);
        }
    }, 5000);
}


window.onload = async function() {
  console.log("🔥 window.onload START");

  initChart();
  setMode("auto");

  console.log("🔥 call loadPlantsFromServer");
  await loadPlantsFromServer(null, { render: false });

  console.log("🔥 call loadActivePlant");
  await loadActivePlant();

  setInterval(fetchSensorData, 3000);
  setInterval(() => {
  if (systemState.mode === 'auto') {
    fetchControlFromServer();
  }
  }, 2000);
  /*fetchSensorData();*/
};
