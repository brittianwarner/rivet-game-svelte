<script lang="ts">
  import type * as THREE from "three";
  import { T } from "@threlte/core";
  import { useGltf } from "@threlte/extras";

  type GLTFResult = {
    nodes: {
      Object_3: THREE.Mesh;
      Object_4: THREE.Mesh;
      Object_5: THREE.Mesh;
      Object_6: THREE.Mesh;
      Object_10: THREE.Mesh;
      Object_11: THREE.Mesh;
      Object_12: THREE.Mesh;
      Object_13: THREE.Mesh;
    };
    materials: {
      road_highway_material: THREE.MeshStandardMaterial;
      desert_ground_material: THREE.MeshStandardMaterial;
      mountains_material: THREE.MeshStandardMaterial;
      road_turn_material: THREE.MeshStandardMaterial;
      road_material: THREE.MeshStandardMaterial;
      metal_material: THREE.MeshStandardMaterial;
    };
  };

  const gltf = useGltf<GLTFResult>("/track1/source_gltf/scene.gltf");
</script>

{#if $gltf}
  <T.Group dispose={false}>
    <T.Group name="Track1Art" rotation={[-Math.PI / 2, 0, 0]}>
      <T.Mesh
        name="RoadHighway"
        geometry={$gltf.nodes.Object_3.geometry}
        material={$gltf.materials.road_highway_material}
        receiveShadow
      />
      <T.Mesh
        name="DesertGround"
        geometry={$gltf.nodes.Object_4.geometry}
        material={$gltf.materials.desert_ground_material}
        receiveShadow
      />
      <T.Mesh
        name="Mountains"
        geometry={$gltf.nodes.Object_5.geometry}
        material={$gltf.materials.mountains_material}
        receiveShadow
      />
      <T.Mesh
        name="RoadTurn"
        geometry={$gltf.nodes.Object_6.geometry}
        material={$gltf.materials.road_turn_material}
        receiveShadow
      />
      <T.Mesh
        name="RoadMainA"
        geometry={$gltf.nodes.Object_10.geometry}
        material={$gltf.materials.road_material}
        receiveShadow
      />
      <T.Mesh
        name="RoadMainB"
        geometry={$gltf.nodes.Object_11.geometry}
        material={$gltf.materials.road_material}
        receiveShadow
      />
      <T.Mesh
        name="MetalPropsA"
        geometry={$gltf.nodes.Object_12.geometry}
        material={$gltf.materials.metal_material}
        castShadow
        receiveShadow
      />
      <T.Mesh
        name="MetalPropsB"
        geometry={$gltf.nodes.Object_13.geometry}
        material={$gltf.materials.metal_material}
        castShadow
        receiveShadow
      />
    </T.Group>
  </T.Group>
{/if}
