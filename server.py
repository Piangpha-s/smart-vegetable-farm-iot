from flask import Flask, request, jsonify, send_from_directory
from pymongo import MongoClient
from datetime import datetime

app = Flask(__name__)

# 🔗 เชื่อมต่อ MongoDB ในเครื่อง
client = MongoClient("mongodb://localhost:27017/")
db = client["smart_farm"]       # ชื่อฐานข้อมูล
plants_collection = db["plants"]   # เก็บข้อมูลพืช
plants_collection.create_index("name", unique=True)
sensors_collection = db["sensor_logs"] # เก็บข้อมูลเซนเซอร์
watering_logs_collection = db["watering_logs"]
system_collection = db["system_state"]


# เก็บค่าจาก ESP32
sensor_data = {
    "temperature": 0,
    "distance": 0,
    "light": 0,
    "soilMoisture": 0
}

# เก็บสถานะการควบคุม (สำหรับให้ ESP32 มาอ่าน)
control_state = {
    "water": 0,   # 0=ปิด, 1=เปิด (GPIO 27 - ปั๊มน้ำ)
    "light": 0,   # 0=ปิด, 1=เปิด (GPIO 25 - ไฟ)
    "fan": 0,      # 0=ปิด, 1=เปิด (GPIO 26 - พัดลม)
        "lastLightOn": None
}

system_mode = {
    "mode": "auto"
}

# Route สำหรับอัปเดตค่าจาก ESP32
@app.route("/update", methods=["GET"])
def update_data():
    temp = request.args.get("temperature", type=float)
    dist = request.args.get("distance", type=float)
    light = request.args.get("light", type=float)
    soil = request.args.get("soil", type=float) 

    print("Received => temp:", temp, "dist:", dist, "light:", light, "soil:", soil)

    if temp is not None:
        sensor_data["temperature"] = temp
    if dist is not None:
        sensor_data["distance"] = dist
    if light is not None:
        sensor_data["light"] = light
    if soil is not None:   
        sensor_data["soilMoisture"] = soil

    # ✅ บันทึกค่าจริงลง MongoDB
    sensors_collection.insert_one({
        "timestamp": datetime.now(),
        **sensor_data
    })

    print("📦 บันทึกข้อมูลเซนเซอร์สำเร็จ:", sensor_data)
    return jsonify(sensor_data)

def get_active_plant():
    state = system_collection.find_one({"key": "activePlant"})
    if state and "plantName" in state:
        return state["plantName"]

    # fallback: แสดงค่าเริ่มต้นเฉย ๆ (ห้ามเขียนกลับ)
    first = plants_collection.find_one({}, {"name": 1})
    return first["name"] if first else None



def set_active_plant(plant_name):
    system_collection.update_one(
        {"key": "activePlant"},
        {"$set": {
            "plantName": plant_name,
            "selectedAt": datetime.now()
        }},
        upsert=True
    )

@app.route("/active_plant", methods=["GET"])
def active_plant():
    return jsonify({
        "plantName": get_active_plant()
    })

@app.route("/active_plant", methods=["POST"])
def set_active_plant_api():
    data = request.get_json() or {}
    plant = data.get("plantName")
    if not plant:
        return jsonify({"message": "no plant"}), 400

    set_active_plant(plant)
    return jsonify({"plantName": plant}), 200

# Route สำหรับดึงข้อมูล JSON
@app.route("/data")
def get_data():
    return jsonify({
        **sensor_data,
        "ts": datetime.now().isoformat(),
        "lastLightOn": control_state.get("lastLightOn")
    })


# หน้าเว็บจะยิง POST มาที่นี่เมื่อกดปุ่มเปิดปิด
@app.route("/control", methods=["POST"])
def control():
    data = request.get_json() or {}
    mode = system_mode.get("mode", "auto")

    print("🎛️ Manual intent received:", data)

    # ✅ เขียนของจริง เฉพาะตอน manual
    if mode == "manual":
        if "water" in data:
            control_state["water"] = int(data["water"])

        if "light" in data:
            prev = int(control_state.get("light", 0))
            newv = int(data["light"])
            control_state["light"] = newv
            if newv == 1 and prev == 0:
                control_state["lastLightOn"] = datetime.now().isoformat()

        if "fan" in data:
            control_state["fan"] = int(data["fan"])

        print("✅ control_state updated (manual):", control_state)
    else:
        print("⛔ Ignored manual intent (mode=auto)")

    # 🔁 ส่งสถานะปัจจุบันกลับให้ dashboard
    return jsonify({
        **control_state,
        "mode": mode
    }), 200


@app.route("/system_mode", methods=["POST"])
def set_system_mode():
    data = request.get_json(silent=True) or {}
    mode = data.get("mode", "auto")
    if mode not in ("auto","manual"):
        return jsonify({"message":"invalid mode"}), 400
    system_mode["mode"] = mode
    print("🔄 เปลี่ยนโหมดระบบเป็น:", mode) 
    return jsonify(system_mode), 200



# หน้า dashboard.html
@app.route("/")
def index():
    return send_from_directory('dashboard', 'dashboard.html')


# Static route สำหรับไฟล์ CSS/JS ภายในโฟลเดอร์ dashboard
@app.route("/dashboard/<path:filename>")
def dashboard_static(filename):
    return send_from_directory('dashboard', filename)


@app.route("/get_control", methods=["GET"])
def get_control():
    # =========================================================
    # 🔎 LOAD STATE
    # =========================================================
    active_name = get_active_plant()
    plant = plants_collection.find_one({"name": active_name}, {"_id": 0})

    mode = system_mode.get("mode", "auto")

    if not plant:
        return jsonify({**control_state, "mode": mode})

    hour = datetime.now().hour
    soil = sensor_data.get("soilMoisture", 0)
    temp = sensor_data.get("temperature", 0)

    # =========================================================
    # 🎯 TARGETS / CONFIG
    # =========================================================
    # Soil
    target_soil_str = plant.get("soilMoistureRange", "60–80%").replace("%", "")
    try:
        min_soil, max_soil = map(int, target_soil_str.split("–"))
    except Exception:
        min_soil, max_soil = 60, 80

    # Temperature
    temp_str = plant.get("temperatureRange", "15–25°C").replace("°C", "")
    try:
        temp_min, temp_max = map(int, temp_str.split("–"))
    except Exception:
        temp_min, temp_max = 15, 25

    # Time config
    light_on  = int(plant.get("lightOnTime", "06:00").split(":")[0])
    light_off = int(plant.get("lightOffTime", "20:00").split(":")[0])
    fan_on    = int(plant.get("fanOnTime", "06:00").split(":")[0])
    fan_off   = int(plant.get("fanOffTime", "20:00").split(":")[0])

    # Sub-modes (สำคัญมาก)
    watering_mode = plant.get("wateringMode", "auto")
    light_mode    = plant.get("lightMode", "auto")
    fan_mode      = plant.get("fanMode", "auto")

    # =========================================================
    # ✋ MANUAL MODE → backend ไม่คิดอะไรเลย
    # =========================================================
    if mode == "manual":
        print("🧠 manual | control_state:", control_state)
        return jsonify({**control_state, "mode": "manual"})

    # =========================================================
    # 🧠 AUTO MODE (respect sub-modes)
    # =========================================================
    if mode == "auto":

        # reset ทุกครั้ง
        control_state["water"] = 0
        control_state["fan"] = 0
        control_state["light"] = 0

        # ================= WATER =================
        if watering_mode == "scheduled":
            now = datetime.now()
            current_minutes = now.hour * 60 + now.minute

            w_on_h, w_on_m = map(int, plant.get("waterOnTime", "08:20").split(":"))
            w_off_h, w_off_m = map(int, plant.get("waterOffTime", "08:22").split(":"))

            water_on_min  = w_on_h * 60 + w_on_m
            water_off_min = w_off_h * 60 + w_off_m

            control_state["water"] = 1 if water_on_min <= current_minutes < water_off_min else 0

        elif watering_mode == "auto":
            if soil < min_soil:
                control_state["water"] = 1
            else:
                control_state["water"] = 0


        # ================= FAN =================
        if fan_mode == "scheduled":
            now = datetime.now()
            current_minutes = now.hour * 60 + now.minute

            fan_on_h, fan_on_m = map(int, plant.get("fanOnTime", "06:00").split(":"))
            fan_off_h, fan_off_m = map(int, plant.get("fanOffTime", "20:00").split(":"))

            fan_on_min  = fan_on_h * 60 + fan_on_m
            fan_off_min = fan_off_h * 60 + fan_off_m

            control_state["fan"] = 1 if fan_on_min <= current_minutes < fan_off_min else 0

        elif fan_mode == "auto":
            if temp > temp_max:
                control_state["fan"] = 1
            else:
                control_state["fan"] = 0


        # ================= LIGHT =================
        if light_mode == "scheduled":
            now = datetime.now()
            current_minutes = now.hour * 60 + now.minute

            light_on_h, light_on_m = map(int, plant.get("lightOnTime", "06:00").split(":"))
            light_off_h, light_off_m = map(int, plant.get("lightOffTime", "20:00").split(":"))

            light_on_min  = light_on_h * 60 + light_on_m
            light_off_min = light_off_h * 60 + light_off_m

            control_state["light"] = 1 if light_on_min <= current_minutes < light_off_min else 0

        elif light_mode == "auto":
            lux = sensor_data.get("light", 0)
            light_threshold = int(plant.get("lightThreshold", 300))

            control_state["light"] = 1 if lux < light_threshold else 0

        
    # =========================================================
    # 🕒 SYSTEM SCHEDULED MODE (legacy / ยังไม่ใช้ก็ได้)
    # =========================================================
    elif mode == "scheduled":
        interval = int(plant.get("wateringInterval", 6))
        control_state["water"] = 1 if (hour % interval == 0) else 0
        control_state["light"] = 1 if light_on <= hour < light_off else 0
        control_state["fan"]   = 1 if fan_on <= hour < fan_off else 0

    # =========================================================
    # 📜 LOG
    # =========================================================
    print(
        f"[DECISION] mode={mode} "
        f"soil={soil}% ({min_soil}-{max_soil}) water={control_state['water']} | "
        f"temp={temp}°C ({temp_min}-{temp_max}) fan={control_state['fan']} | "
        f"light={control_state['light']} "
        f"(sub: water={watering_mode}, light={light_mode}, fan={fan_mode})"
    )

    return jsonify({**control_state, "mode": mode})


#เพิ่ม Route สำหรับจัดการ “พืช”
@app.route("/plants", methods=["POST"])
def add_plant():
    data = request.get_json()
    name = data.get("name")

    if not name:
        return jsonify({"message": "ไม่มีชื่อพืช"}), 400

    if plants_collection.find_one({"name": name}):
        return jsonify({"message": f"พืช '{name}' มีอยู่แล้ว"}), 400

    plants_collection.insert_one(data)
    return jsonify({"message": f"เพิ่มพืช '{name}' เรียบร้อย"}), 201

@app.route("/plants/<name>", methods=["PUT"])
def update_plant(name):
    data = request.get_json()
    new_name = data.get("name")

    # ถ้าเปลี่ยนชื่อ → ตรวจว่าไม่ชนกับชื่ออื่น
    if new_name and new_name != name:
        if plants_collection.find_one({"name": new_name}):
            return jsonify({"message": f"ชื่อพืช '{new_name}' มีอยู่แล้ว"}), 400

        # ✅ เปลี่ยนชื่อก่อน
        plants_collection.update_one({"name": name}, {"$set": {"name": new_name}})
        name = new_name  # ✅ ใช้ชื่อใหม่ในการอัปเดต field อื่น

    # ✅ อัปเดต field อื่น
    update_data = data.copy()
    update_data.pop("name", None)

    result = plants_collection.update_one({"name": name}, {"$set": update_data})

    if result.matched_count == 0:
        return jsonify({"message": f"ไม่พบพืชชื่อ '{name}'"}), 404

    return jsonify({"message": f"แก้ไขพืช '{name}' สำเร็จ"}), 200

@app.route("/plants", methods=["GET"])
def get_plants():
    plants = list(plants_collection.find({}, {"_id": 0}))
    return jsonify(plants)


@app.route("/log_watering", methods=["POST"])
def log_watering():
    data = request.get_json()
    plant_name = data.get("plantName")
    timestamp = datetime.now()

    if not plant_name:
        return jsonify({"message": "ไม่มีชื่อพืช"}), 400

    watering_logs_collection.insert_one({
        "plantName": plant_name,
        "timestamp": timestamp
    })

    plants_collection.update_one(
        {"name": plant_name},
        {"$set": {"lastWateredTime": timestamp}}
    )

    print(f"📝 บันทึกการรดน้ำ: {plant_name} @ {timestamp}")
    return jsonify({"message": "บันทึกการรดน้ำสำเร็จ"}), 200


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=True,
        use_reloader=False
    )
