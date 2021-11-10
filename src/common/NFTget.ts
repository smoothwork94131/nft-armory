import { PublicKey } from '@solana/web3.js';
import { Account, AnyPublicKey, programs } from '@metaplex/js';
import axios from 'axios';
import { EditionData } from '@metaplex/js/lib/programs/metadata';
import {
  getEnumKeyByEnumValue,
  joinArraysOnKey,
  okToFailAsync,
  stringifyPubkeysInArray,
} from './helpers/util';
import { deserializeTokenAccount, deserializeTokenMint } from './helpers/spl-token';
import { INFT, INFTParams } from './helpers/types';
import useCluster from '@/composables/cluster';
import { EE } from '../globals';
import { LoadStatus, UpdateLoadingParams } from '@/composables/loading';

const {
  metaplex: { Store, AuctionManager },
  metadata: { Metadata },
  auction: { Auction },
  vault: { Vault },
} = programs;

const { getConnection } = useCluster();

// --------------------------------------- getters

// will fetch all the editions from master's PDA. Can be long!
export async function getEditionsFromMaster(masterPDA: AnyPublicKey) {
  const masterInfo = await Account.getInfo(getConnection(), masterPDA);
  const me = new programs.metadata.MasterEdition(masterPDA, masterInfo);
  const foundEditions = await me.getEditions(getConnection());
  console.log(`Found a total of ${foundEditions.length} Editions for ME: ${masterPDA}`);
  return foundEditions;
}

// returns metadatas for all NFTs where EITHER of the creators is listed
// so if one has 9 and other 2, total will be 11
export async function getMetadataByCreators(creators: AnyPublicKey[]) {
  const nfts = await Metadata.findMany(getConnection(), {
    creators,
  });
  console.log(`Found a total of ${nfts.length} NFTs for creators: ${creators}`);
  return nfts;
}

export async function getMetadataByUpdateAuthority(updateAuthority: AnyPublicKey) {
  const nfts = await Metadata.findMany(getConnection(), {
    updateAuthority,
  });
  console.log(`Found a total of ${nfts.length} NFTs for authority: ${updateAuthority}`);
  return nfts;
}

export async function getMetadataByMint(mint: AnyPublicKey) {
  const nfts = await Metadata.findMany(getConnection(), {
    mint,
  });
  console.log(`Found a total of ${nfts.length} NFTs for mint: ${mint}`);
  return nfts;
}

export async function getMetadataByOwner(owner: AnyPublicKey) {
  const nfts = await Metadata.findByOwnerV2(getConnection(), owner);
  console.log(`Found a total of ${nfts.length} NFTs for owner: ${owner}`);
  return nfts;
}

export async function getHolderByMint(mint: PublicKey) {
  const tokens = await getConnection().getTokenLargestAccounts(mint);
  if (tokens && tokens.value.length > 0) {
    return tokens.value[0].address; // since it's an NFT, we just grab the 1st account
  }
}

export async function getExternalMetadata(uri: string) {
  const response = await axios.get(uri);
  if (response) {
    return response.data;
  }
}

export async function getParentEdition(editionData: EditionData) {
  const masterEditionPDA = new PublicKey(editionData.parent);
  const masterInfo = await Account.getInfo(getConnection(), masterEditionPDA);
  const masterEditionData = new programs.metadata.MasterEdition(masterEditionPDA, masterInfo).data;
  return { masterEditionPDA, masterEditionData };
}

export async function getEditionInfoByMint(mint: PublicKey) {
  // untriaged
  const pda = await programs.metadata.Edition.getPDA(mint);
  const info = await Account.getInfo(getConnection(), pda);
  const key = info?.data[0];

  const editionType = getEnumKeyByEnumValue(programs.metadata.MetadataKey, key);
  let editionPDA;
  let editionData;
  let masterEditionPDA;
  let masterEditionData;

  // triaged
  switch (key) {
    case programs.metadata.MetadataKey.EditionV1:
      editionPDA = pda;
      editionData = new programs.metadata.Edition(pda, info).data;
      // we can further get master edition info, since we know the parent
      ({ masterEditionPDA, masterEditionData } = await okToFailAsync(getParentEdition, [
        editionData,
      ]));
      break;
    case programs.metadata.MetadataKey.MasterEditionV1:
    case programs.metadata.MetadataKey.MasterEditionV2:
      masterEditionData = new programs.metadata.MasterEdition(pda, info).data;
      masterEditionPDA = pda;
      break;
  }

  return {
    editionType,
    editionPDA,
    editionData,
    masterEditionPDA,
    masterEditionData,
  };
}

// --------------------------------------- deserializers

export function deserializeMetadataOnchain(metadatas: programs.metadata.Metadata[]): INFT[] {
  return metadatas.map(
    (m) =>
      ({
        mint: new PublicKey(m.data.mint),
        metadataPDA: m.pubkey,
        metadataOnchain: m.data,
      } as INFT)
  );
}

// --------------------------------------- together

export async function turnMetadatasIntoNFTs(
  metadatas: programs.metadata.Metadata[]
): Promise<INFT[]> {
  let NFTs = deserializeMetadataOnchain(metadatas);

  // todo temp
  // NFTs = NFTs.slice(0, 100);

  const enrichedNFTs = await Promise.all(
    NFTs.map(async (n) => {
      console.log(`Processing NFT ${n.mint}`);
      const address = await okToFailAsync(getHolderByMint, [new PublicKey(n.metadataOnchain.mint)]);
      return {
        mint: n.mint,
        address,
        splTokenInfo: await okToFailAsync(deserializeTokenAccount, [n.mint, address]),
        splMintInfo: await okToFailAsync(deserializeTokenMint, [n.mint]),
        metadataExternal: await okToFailAsync(getExternalMetadata, [n.metadataOnchain.data.uri]),
        ...(await okToFailAsync(getEditionInfoByMint, [n.mint], true)),
      };
    })
  );
  NFTs = joinArraysOnKey(NFTs, enrichedNFTs, 'mint');
  console.log(`Prepared a total of ${NFTs.length} NFTs`);
  return NFTs;
}

export async function getNFTs(
  { owner, creators, mint, updateAuthority } = {} as INFTParams
): Promise<INFT[]> {
  let metadatas;
  if (owner) {
    console.log('Time to get em NFTs!', owner.toBase58());
    metadatas = await getMetadataByOwner(owner);
  } else if (creators && creators.length > 0) {
    console.log('Time to get em NFTs!', stringifyPubkeysInArray(creators));
    metadatas = await getMetadataByCreators(creators);
  } else if (mint) {
    console.log('Time to get em NFTs!', mint.toBase58());
    metadatas = await getMetadataByMint(mint);
  } else if (updateAuthority) {
    console.log('Time to get em NFTs!', updateAuthority.toBase58());
    metadatas = await getMetadataByUpdateAuthority(updateAuthority);
  } else {
    throw new Error('You must pass one of owner / creators / mint / updateAuthority');
  }
  if (metadatas.length === 0) {
    // todo emit that no nfts were found
    return [];
  }
  EE.emit('loading', {
    newStatus: LoadStatus.Loading,
    newProgress: 50,
    maxProgress: 90,
    newText: `Found a total of ${metadatas.length} NFTs. Fetching metadata...`,
  } as UpdateLoadingParams);
  return turnMetadatasIntoNFTs(metadatas);
}